Package.describe({
  name: "babel-runtime",
  summary: "Runtime support for output of Babel transpiler",
  version: '1.3.0-rc17.8',
  documentation: 'README.md'
});

Npm.depends({
  "meteor-babel-helpers": "0.0.3"
});

Package.onUse(function (api) {
  api.use("modules");
  api.mainModule("babel-runtime.js");
  api.addFiles("legacy.js", "legacy");
  api.export("meteorBabelHelpers");
});
