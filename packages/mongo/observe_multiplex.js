import { log } from "util";

var Future = Npm.require('fibers/future');

ObserveMultiplexer = function (options) {
  var self = this;

  if (!options || !_.has(options, 'ordered'))
    throw Error("must specified ordered");

  Package.facts && Package.facts.Facts.incrementServerFact(
    "mongo-livedata", "observe-multiplexers", 1);

  self._ordered = options.ordered;
  self._onStop = options.onStop || function () {};
  self._queue = new Meteor._SynchronousQueue();
  self._handles = {};
  self._readyFuture = new Future;
  self._cache = new LocalCollection._CachingChangeObserver({
    ordered: options.ordered});
  // Number of addHandleAndSendInitialAdds tasks scheduled but not yet
  // running. removeHandle uses this to know if it's time to call the onStop
  // callback. 
  self._addHandleTasksScheduledButNotPerformed = 0;
  // Whether or not to allow batching of consecutive messages
  self._allowBatching = options.allowBatching;
  // When callbacks are fired within this ms interval, batch them together
  self._bufferedCallsInterval = 10;
  // Flush buffer at least every 500ms
  self._bufferedCallsMaxAge = 500;
  // The timeoutHandle for the callback buffer
  self._bufferedCallsFlushHandle = null;
  // Date at which the callbacks should be flushed, regardless of any timeout
  self._bufferedCallsFlushAt = null;
  // A buffer for callbacks
  self._bufferedCalls = [];

  _.each(self.callbackNames(), function (callbackName) {
    self[callbackName] = function (/* ... */) {
      self._applyCallback(callbackName, _.toArray(arguments));
    };
  });
};

_.extend(ObserveMultiplexer.prototype, {
  addHandleAndSendInitialAdds: function (handle) {
    var self = this;

    // Check this before calling runTask (even though runTask does the same
    // check) so that we don't leak an ObserveMultiplexer on error by
    // incrementing _addHandleTasksScheduledButNotPerformed and never
    // decrementing it.
    if (!self._queue.safeToRunTask())
      throw new Error("Can't call observeChanges from an observe callback on the same query");
    ++self._addHandleTasksScheduledButNotPerformed;

    Package.facts && Package.facts.Facts.incrementServerFact(
      "mongo-livedata", "observe-handles", 1);

    self._queue.runTask(function () {
      self._handles[handle._id] = handle;
      // Send out whatever adds we have so far (whether or not we the
      // multiplexer is ready).
      self._sendAdds(handle);
      --self._addHandleTasksScheduledButNotPerformed;
    });
    // *outside* the task, since otherwise we'd deadlock
    self._readyFuture.wait();
  },

  // Remove an observe handle. If it was the last observe handle, call the
  // onStop callback; you cannot add any more observe handles after this.
  //
  // This is not synchronized with polls and handle additions: this means that
  // you can safely call it from within an observe callback, but it also means
  // that we have to be careful when we iterate over _handles.
  removeHandle: function (id) {
    var self = this;

    // This should not be possible: you can only call removeHandle by having
    // access to the ObserveHandle, which isn't returned to user code until the
    // multiplex is ready.
    if (!self._ready())
      throw new Error("Can't remove handles until the multiplex is ready");

    delete self._handles[id];

    Package.facts && Package.facts.Facts.incrementServerFact(
      "mongo-livedata", "observe-handles", -1);

    if (_.isEmpty(self._handles) &&
        self._addHandleTasksScheduledButNotPerformed === 0) {
      self._stop();
    }
  },
  _stop: function (options) {
    var self = this;
    options = options || {};

    // It shouldn't be possible for us to stop when all our handles still
    // haven't been returned from observeChanges!
    if (! self._ready() && ! options.fromQueryError)
      throw Error("surprising _stop: not ready");

    // Call stop callback (which kills the underlying process which sends us
    // callbacks and removes us from the connection's dictionary).
    self._onStop();
    Package.facts && Package.facts.Facts.incrementServerFact(
      "mongo-livedata", "observe-multiplexers", -1);

    // Cause future addHandleAndSendInitialAdds calls to throw (but the onStop
    // callback should make our connection forget about us).
    self._handles = null;
  },

  // Allows all addHandleAndSendInitialAdds calls to return, once all preceding
  // adds have been processed. Does not block.
  ready: function () {
    var self = this;
    self._queue.queueTask(function () {
      if (self._ready())
        throw Error("can't make ObserveMultiplex ready twice!");
      self._readyFuture.return();
    });
  },

  // If trying to execute the query results in an error, call this. This is
  // intended for permanent errors, not transient network errors that could be
  // fixed. It should only be called before ready(), because if you called ready
  // that meant that you managed to run the query once. It will stop this
  // ObserveMultiplex and cause addHandleAndSendInitialAdds calls (and thus
  // observeChanges calls) to throw the error.
  queryError: function (err) {
    var self = this;
    self._queue.runTask(function () {
      if (self._ready())
        throw Error("can't claim query has an error after it worked!");
      self._stop({fromQueryError: true});
      self._readyFuture.throw(err);
    });
  },

  // Calls "cb" once the effects of all "ready", "addHandleAndSendInitialAdds"
  // and observe callbacks which came before this call have been propagated to
  // all handles. "ready" must have already been called on this multiplexer.
  onFlush: function (cb) {
    var self = this;
    self._queue.queueTask(function () {
      if (!self._ready())
        throw Error("only call onFlush on a multiplexer that will be ready");
      cb();
    });
  },

  callbackNames: function () {
    var self = this;
    if (self._ordered)
      return ["addedBefore", "changed", "movedBefore", "removed"];
    else
      return ["added", "changed", "removed"];
  },

  _ready: function () {
    return this._readyFuture.isResolved();
  },

  _applyCallback: function (callbackName, args) {
    var self = this;

    self._queue.queueTask(function () {
      // If we stopped in the meantime, do nothing.
      if (!self._handles) {
        return;
      }

      // If we haven't finished the initial adds, then we should only be getting
      // adds.
      if (!self._ready() &&
          (callbackName !== 'added' && callbackName !== 'addedBefore')) {
        throw new Error("Got " + callbackName + " during initial adds");
      }
  
      args[0] = MongoID.idStringify(args[0]);

      if (self._allowBatching) {
        // Add the callback to the bufferedCalls
        self._bufferedCalls.push({
          action: callbackName,
          args: args
        });

        if (self._bufferedCallsFlushAt === null) {
          self._bufferedCallsFlushAt =
            new Date().valueOf() + self._bufferedCallsMaxAge;
        } else if (self._bufferedCallsFlushAt < new Date().valueOf()) {
          self._flushBufferedCalls();
          return;
        }

        if (self._bufferedCallsFlushHandle) {
          clearTimeout(self._bufferedCallsFlushHandle);
        }

        self._bufferedCallsFlushHandle = setTimeout(
          self._flushBufferedCalls.bind(self),
          self._bufferedCallsInterval
        );
      }
      else {
        // If we stopped in the meantime, do nothing.
        if (!self._handles) {
          return;
        }

        _.each(_.keys(self._handles), function (handleId) {
          var handle = self._handles && self._handles[handleId];

          if (!handle) {
            return;
          }

          var callback = handle['_' + callbackName];

          // clone arguments so that callbacks can mutate their arguments
          callback && callback.apply(null, EJSON.clone(args));
        });
      }
    });
  },

  _flushBufferedCalls: function() {
    var self = this;

    // If we stopped in the meantime, do nothing.
    if (!self._handles) {
      return;
    }

    if (self._bufferedCallsFlushHandle) {
      clearTimeout(self._bufferedCallsFlushHandle);
  
      self._bufferedCallsFlushHandle = null;
    }

    self._bufferedCallsFlushAt = null;
      
    var messages = self._bufferedCalls;

    _.each(messages, (message) => {
      // First, apply the change to the cache.
      // XXX We could make applyChange callbacks promise not to hang on to any
      // state from their arguments (assuming that their supplied callbacks
      // don't) and skip this clone. Currently 'changed' hangs on to state
      // though.
      self._cache.applyChange[message.action].apply(null, message.args);
    });

    // TODO remove this comment which shows the effect clearly
    console.log(messages.length);
  
    self._bufferedCalls = [];

    // Now multiplex the callbacks out to all observe handles. It's OK if
    // these calls yield; since we're inside a task, no other use of our queue
    // can continue until these are done. (But we do have to be careful to not
    // use a handle that got removed, because removeHandle does not use the
    // queue; thus, we iterate over an array of keys that we control.)
    _.each(_.keys(self._handles), function (handleId) {
      var handle = self._handles && self._handles[handleId];

      if (!handle) {
        return;
      }

      var callback = handle._messages;

      // clone arguments so that callbacks can mutate their arguments
      callback && callback.apply(null, [EJSON.clone(messages)]);
    });
  },

  // Sends initial adds to a handle. It should only be called from within a task
  // (the task that is processing the addHandleAndSendInitialAdds call). It
  // synchronously invokes the handle's added or addedBefore; there's no need to
  // flush the queue afterwards to ensure that the callbacks get out.
  _sendAdds: function (handle) {
    var self = this;
    if (self._queue.safeToRunTask())
      throw Error("_sendAdds may only be called from within a task!");
    var add = self._ordered ? handle._addedBefore : handle._added;
    if (!add)
      return;
    // note: docs may be an _IdMap or an OrderedDict
    self._cache.docs.forEach(function (doc, id) {
      if (!_.has(self._handles, handle._id))
        throw Error("handle got removed before sending initial adds!");
      var fields = EJSON.clone(doc);
      delete fields._id;
      if (self._ordered)
        add(id, fields, null); // we're going in order, so add at end
      else
        add(id, fields);
    });
  }
});

var nextObserveHandleId = 1;

ObserveHandle = function (multiplexer, callbacks) {
  var self = this;
  // The end user is only supposed to call stop().  The other fields are
  // accessible to the multiplexer, though.
  self._multiplexer = multiplexer;

  if (multiplexer._allowBatching) {
    if (_.isFunction(callbacks)) {
      self._messages = callbacks;
  
      self._added = self._addedBefore = function() {
        multiplexer._applyCallback('added', arguments);
      }
    }
    else {      
      throw new Error(
        'Multiplexer.allowBatching requires a single callback in ObserveHandle.'
      );
    }
  }
  else {
    _.each(multiplexer.callbackNames(), function (name) {
      if (callbacks[name]) {
        self['_' + name] = callbacks[name];
      } else if (name === "addedBefore" && callbacks.added) {
        // Special case: if you specify "added" and "movedBefore", you get an
        // ordered observe where for some reason you don't get ordering data on
        // the adds.  I dunno, we wrote tests for it, there must have been a
        // reason.
        self._addedBefore = function (id, fields, before) {
          callbacks.added(id, fields);
        };
      }
    });
  }

  self._stopped = false;
  self._id = nextObserveHandleId++;
};

ObserveHandle.prototype.stop = function () {
  var self = this;
  if (self._stopped) {
    return;
  }
  self._stopped = true;
  self._multiplexer.removeHandle(self._id);
};
