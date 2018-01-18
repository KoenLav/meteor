Package.describe({
  summary: "Retry logic with exponential backoff",
  version: '1.1.0-rc161.9'
});

Package.onUse(function (api) {
  api.use('ecmascript');
  api.use('random');
  api.mainModule('retry.js');
  api.export('Retry');
});
