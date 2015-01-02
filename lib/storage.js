
'use strict';

var Q = require('q');
var Datastore = require('nedb');

function Storage(path) {
  this._db = new Datastore({ filename: path, autoload: true });
  this._db.ensureIndex({
    fieldName: 'key',
    unique: true
  });

  promisifyDatastore(this._db);
}

/**
 *  @return {promise} to return documents where document.key is in {keys}
 */
Storage.prototype.get = function(keys) {
  if (!Array.isArray(keys))
    keys = [keys];

  return promisifyDBCall(this._db.find({
    key: { $in: keys }
  }));
}

Storage.prototype.getAll = function() {
  return promisifyDBCall(this._db.find({}));
}

Storage.prototype.putOne = function(key, value) {
  var self = this;

  // return this.get(key)
  // .then(function(docs) {
    // if (docs.length) {
    //   self._db.insert({
    //     key: key,
    //     value: value
    //   });
    // }
    // else {
     return self._db.update({
        key: key
      }, {
        $set: {
          key: key,
          value: value
        }
      }, {
        upsert: true
      });
    // }
  // });
}

Storage.prototype.remove = function(keys) {
  return this._db.remove({
    $in: { key: keys }
  });
}

Storage.prototype.clear = function() {
  return this._db.remove({});
}

// This utilizes the exec function on nedb to turn function calls into promises
function promisifyDBCall(obj) {
  return Q.Promise(function (resolve, reject) {
    obj.exec(function (error, result) {
      if (error) {
        return reject(error);
      } else {
        return resolve(result);
      }
    });
  });
}

function promisifyDatastore(datastore) {
  // datastore.find   = Q.denodeify(datastore.find, datastore);
  datastore.insert = Q.denodeify(datastore.insert.bind(datastore));
  datastore.update = Q.denodeify(datastore.update.bind(datastore));
  datastore.remove = Q.denodeify(datastore.remove.bind(datastore));
}

module.exports = Storage;