
'use strict';

var express = require('express');
var router = express.Router();
var concat = require('concat-stream');

router.put('/', function(req, res) {
  if (!('key' in req.query)) return res.status(400).send({ message: 'Missing requred query parameter: key' });

  var key = req.query.key;
  var keeper = req.app.get('keeper');

  req.pipe(concat(function(val) {
    keeper.put(key, val)
      .then(function() {
        res.status(200).end();
      })
      .done();
  }));

});

module.exports = router;