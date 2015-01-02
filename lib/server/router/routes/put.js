
'use strict';

var express = require('express');
var router = express.Router();
var common = require('../../../common');
// var base58 = require('bs58');

router.post('/', function(req, res) {
  var key = common.requireParam(req, 'key');
  var val = common.requireParam(req, 'val');
  var keeper = req.app.get('keeper');

  keeper
    .put(key, new Buffer(val, 'base64'))
    .then(function() {
      keeper.seed(key, val);
      res.status(200).end();
    })
    .done();
});

module.exports = router;