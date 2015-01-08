
'use strict';

var Q = require('q');
var fs = require('fs');
var DHT = require('bittorrent-dht');

Array.prototype.remove = function(value) {
  var idx = this.indexOf(value);
  if (idx !== -1) return this.splice(idx, 1); // The second parameter is the number of elements to remove.
  
  return false;
}

var Common = {
  httpError: function(statusCode, msg) {
    var err = new Error(msg);
    err.status = statusCode;
    return err;
  },

  requireOption: function(options, option) {
    if (!(option in options)) throw new Error('Missing required option: ' + option);

    return options[option];
  },

  requireOptions: function(options /*, option1, option2... */) {
    [].slice.call(arguments, 1).map(function(arg) {
      Common.requireOption(options, arg);
    });
  },

  bindPrototypeFunctions: function(obj) {
    // bind all prototype functions to self  
    var proto = obj.constructor.prototype;
    for (var p in proto) {
      var val = proto[p];
      if (typeof val === 'function')
        obj[p] = obj[p].bind(obj);
    }
  },

  pushUniq: function(a, b) {
    for (var i = 0; i < b.length; i++) {
      if (a.indexOf(b[i]) === -1)
        a.push(b[i]);
    }
  },

  requireParam: function(req, param) {
    var params = req.method === 'POST' ? req.body : req.query;

    if (!(param in params)) throw Common.httpError(400, 'Missing required parameter: ' + param);

    return params[param];
  },

  prettify: function(pojo) {
    return JSON.stringify(pojo, null, 2);
  },

  clone: function(obj) {
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

  dht: function(filePath) {
    return Q.Promise(function(resolve) {      
      if (!filePath) return resolve(new DHT());

      Q.ninvoke(fs, 'readFile', filePath)
      .then(function(buf) {
        var nodes = JSON.parse(buf.toString());
        if (!nodes.length) return Common.dht();

        return new DHT({ bootstrap: nodes });
      })
      .catch(function(err) {
        resolve(new DHT());
      });
    })
  },

  string: function(val, encoding) {
    return typeof val === 'string' ? val : val.toString(encoding || 'utf8');
  },

  buffer: function(val, encoding) {
    return Buffer.isBuffer(val) ? val : new Buffer(val, encoding || 'utf8');
  }
}

module.exports = Common;