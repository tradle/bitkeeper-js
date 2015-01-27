'use strict';

var Q = require('q');
var fs = require('fs');
var DHT = require('bittorrent-dht');
var path = require('path');

Array.prototype.remove = function (value) {
  var idx = this.indexOf(value);
  if (idx !== -1) return this.splice(idx, 1); // The second parameter is the number of elements to remove.

  return false;
}

var Common = {
  pushUniq: function (a, b) {
    for (var i = 0; i < b.length; i++) {
      if (a.indexOf(b[i]) === -1)
        a.push(b[i]);
    }
  },

  prettify: function (pojo) {
    return JSON.stringify(pojo, null, 2);
  },

  clone: function (obj) {
    var c = {};
    for (var p in obj) {
      if (obj.hasOwnProperty(p)) {
        var val = obj[p];
        if (Array.isArray(val))
          c[p] = val.map(Common.clone);
        else if (typeof val === 'object')
          c[p] = Common.clone(val);
        else
          c[p] = val;
      }
    }

    return c;
  },

  dht: function (filePath) {
    if (!filePath) return Q.resolve(new DHT());

    filePath = path.resolve(filePath);
    return Q.ninvoke(fs, 'readFile', filePath)
      .then(function (buf) {
        var nodes = JSON.parse(buf.toString());
        if (!nodes.length) return Common.dht();

        return new DHT({
          bootstrap: nodes
        });
      })
      .catch(function (err) {
        return Common.dht();
      });
  },

  string: function (val, encoding) {
    return typeof val === 'string' ? val : val.toString(encoding || 'utf8');
  },

  buffer: function (val, encoding) {
    return Buffer.isBuffer(val) ? val : new Buffer(val, encoding || 'utf8');
  }
}

module.exports = Common;
