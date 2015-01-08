
'use strict';

var express = require('express');
var router = express.Router();
var common = require('../../../common');
// var base58 = require('bs58');

router.get('/', function(req, res) {
  var key = req.query.key;
  var keys = req.query.keys;

  if (!key && !keys) throw common.httpError(400, 'Missing required parameter: "key" or "keys"');

  keys = key ? [key] : keys.split(',');
  // keys = keys.map(function(k) {
  //   return new Buffer(base58.decode(k)).toString('hex');
  // });

  req.app.get('keeper')
    .get(keys)
    .done(function(results) {
      // results = results.map(function(r) { return r.value });

      var value = key ? results[0] : results;
      if (typeof value === 'undefined') 
        res.status(404).end();
      else 
        res.status(200).send(value);
    });
});

module.exports = router;