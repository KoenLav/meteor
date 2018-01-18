Package.describe({
  name: "modules",
  version: "0.11.3-rc161.9",
  summary: "CommonJS module system",
  documentation: "README.md"
});

Npm.depends({
  reify: "0.13.7"
});

Package.onUse(function(api) {
  api.use("modules-runtime");
  api.mainModule("client.js", "client");
  api.mainModule("server.js", "server");
  api.export("meteorInstall");
});
