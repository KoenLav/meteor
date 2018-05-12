// A "crossbar" is a class that provides structured notification registration.
// See _match for the definition of how a notification matches a trigger.
// All notifications and triggers must have a string key named 'collection'.
export default class Crossbar {
  constructor(options) {
    var self = this;
    options = options || {};

    self.listenerId = 1;
    self.bufferId = 1;
    // map from collection name (string) -> listener id -> object. each object has
    // keys 'trigger', 'callback'.  As a hack, the empty string means "no
    // collection".
    self.listenersByCollection = {};
    // An object which holds the buffered changes per collection
    self.buffersPerCollection = {};
    
    self.factPackage = options.factPackage || "livedata";
    self.factName = options.factName || null;
  }

  // msg is a trigger or a notification
  _collectionForMessage(msg) {
    var self = this;
    if (! _.has(msg, 'collection')) {
      return '';
    } else if (typeof(msg.collection) === 'string') {
      if (msg.collection === '')
        throw Error("Message has empty collection!");
      return msg.collection;
    } else {
      throw Error("Message has non-string collection!");
    }
  }

  // Listen for notification that match 'trigger'. A notification
  // matches if it has the key-value pairs in trigger as a
  // subset. When a notification matches, call 'callback', passing
  // the actual notification.
  //
  // Returns a listen handle, which is an object with a method
  // stop(). Call stop() to stop listening.
  //
  // XXX It should be legal to call fire() from inside a listen()
  // callback?
  listen(trigger, callback) {
    var self = this;
    var id = self.listenerId++;

    var collection = self._collectionForMessage(trigger);
    var record = {trigger: EJSON.clone(trigger), callback: callback};
    if (! _.has(self.listenersByCollection, collection)) {
      self.listenersByCollection[collection] = {};
    }
    self.listenersByCollection[collection][id] = record;

    if (self.factName && Package.facts) {
      Package.facts.Facts.incrementServerFact(
        self.factPackage, self.factName, 1);
    }

    return {
      stop: function () {
        if (self.factName && Package.facts) {
          Package.facts.Facts.incrementServerFact(
            self.factPackage, self.factName, -1);
        }
        delete self.listenersByCollection[collection][id];
        if (_.isEmpty(self.listenersByCollection[collection])) {
          delete self.listenersByCollection[collection];
        }
      }
    };
  }

  // Fire the provided 'notification' (an object whose attribute
  // values are all JSON-compatibile) -- inform all matching listeners
  // (registered with listen()).
  //
  // If fire() is called inside a write fence, then each of the
  // listener callbacks will be called inside the write fence as well.
  //
  // The listeners may be invoked in parallel, rather than serially.
  fire(notification) {
    var self = this;
    var collection = self._collectionForMessage(notification);
    var listenersForCollection = self.listenersByCollection[collection];
    var buffersForCollection = self.buffersPerCollection[collection];

    if (listenersForCollection) {
      var callbackIds = [];

      _.each(listenersForCollection, function (l, id) {
        if (self._matches(notification, l.trigger)) {
          callbackIds.push(id);
        }
      });

      // Listener callbacks can yield, so we need to first find all the ones that
      // match in a single iteration over self.listenersByCollection (which can't
      // be mutated during this iteration), and then invoke the matching
      // callbacks, checking before each call to ensure they haven't stopped.
      // Note that we don't have to check that
      // self.listenersByCollection[collection] still === listenersForCollection,
      // because the only way that stops being true is if listenersForCollection
      // first gets reduced down to the empty object (and then never gets
      // increased again).
      _.each(callbackIds, function (id) {
        if (_.has(listenersForCollection, id)) {
          listenersForCollection[id].callback(notification);
        }
      });
    }

    if (buffersForCollection) {
      
    }
  }

  buffer(trigger, callback) {
    var self = this;
    var id = self.bufferId++;

    var collection = self._collectionForMessage(trigger);
    var record = {trigger: EJSON.clone(trigger), callback: callback};
    
    self.buffersPerCollection[collection] = self.buffersPerCollection[collection] || {};

    self.buffersPerCollection[collection] = self.buffersPerCollection[collection] || {
      records: [],
      buffer: []
    };

    self.buffersPerCollection[collection].records[id] = record;
    
    // When callbacks are fired within this ms interval, batch them together
    self._bufferedCallsInterval = 10;
    // Flush buffer at least every 500ms
    self._bufferedCallsMaxAge = 500;
    // The timeoutHandle for the callback buffer
    self._bufferedCallsFlushHandle = null;
    // Date at which the buffer should be flushed, regardless of any timeout
    self._bufferedCallsFlushAt = null;

    return {
      stop: function () {
        delete self.buffersPerCollection[collection].records[id];

        if (_.isEmpty(self.buffersPerCollection[collection].records)) {
          // TODO: clear any outstanding timeouts?
          delete self.buffersPerCollection[collection];
        }
      }
    };
  }

  flush() {

  }

  // A notification matches a trigger if all keys that exist in both are equal.
  //
  // Examples:
  //  N:{collection: "C"} matches T:{collection: "C"}
  //    (a non-targeted write to a collection matches a
  //     non-targeted query)
  //  N:{collection: "C", id: "X"} matches T:{collection: "C"}
  //    (a targeted write to a collection matches a non-targeted query)
  //  N:{collection: "C"} matches T:{collection: "C", id: "X"}
  //    (a non-targeted write to a collection matches a
  //     targeted query)
  //  N:{collection: "C", id: "X"} matches T:{collection: "C", id: "X"}
  //    (a targeted write to a collection matches a targeted query targeted
  //     at the same document)
  //  N:{collection: "C", id: "X"} does not match T:{collection: "C", id: "Y"}
  //    (a targeted write to a collection does not match a targeted query
  //     targeted at a different document)
  _matches(notification, trigger) {
    // Most notifications that use the crossbar have a string `collection` and
    // maybe an `id` that is a string or ObjectID. We're already dividing up
    // triggers by collection, but let's fast-track "nope, different ID" (and
    // avoid the overly generic EJSON.equals). This makes a noticeable
    // performance difference; see https://github.com/meteor/meteor/pull/3697
    if (typeof(notification.id) === 'string' &&
        typeof(trigger.id) === 'string' &&
        notification.id !== trigger.id) {
      return false;
    }
    if (notification.id instanceof MongoID.ObjectID &&
        trigger.id instanceof MongoID.ObjectID &&
        ! notification.id.equals(trigger.id)) {
      return false;
    }

    return _.all(trigger, function (triggerValue, key) {
      return !_.has(notification, key) ||
        EJSON.equals(triggerValue, notification[key]);
    });
  }
}
