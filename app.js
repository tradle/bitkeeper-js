
'use strict';

var Keeper = require('./');
var fs = require('fs');
var path = require('path');

var config;
if (process.argv[2]) {
  var configPath = path.join(__dirname, process.argv[2]);
  config = fs.readFileSync(configPath, { encoding: 'utf8' });
  config = JSON.parse(config);
}
else
  config = require('./conf/config');

if (process.argv.indexOf('--test') !== -1) {
  var DHT = require('bittorrent-dht/client');
  config.dht = new DHT({ bootstrap: false });
}

var keeper = new Keeper(config);
keeper.on('ready', function() {
  console.log('ready');
});

keeper.on('put', function(key, val) {
  console.log('put: ' + key + ' -> ' + val);  
});