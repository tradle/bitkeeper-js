
'use strict';

var Q = require('q');
var fs = require('fs');
var walk = require('walk');
var rimraf = Q.nfbind(require('rimraf'));
var mkdirp = require('mkdirp');
var path = require('path');
var readFile = Q.nfbind(fs.readFile);
var writeFile = Q.nfbind(fs.writeFile);
var unlink = Q.nfbind(fs.unlink);
var debug = require('debug')('fsStorage');

function Storage(folder) {
  this._folder = folder;
  mkdirp.sync(folder);
}

Storage.prototype.getOne = function(key) {
  return readFile(this.getAbsPathForKey(key));
}

Storage.prototype.exists = function(key) {
  var filePath = this.getAbsPathForKey(key);
  return Q.Promise(function(resolve) {
    fs.exists(filePath, resolve);
  });
}

Storage.prototype.getAbsPathForKey = function(key) {
  return path.join(this._folder, key.slice(0, 2), key.slice(2));
}

Storage.prototype.getMany = function(keys) {
  var self = this;

  var tasks = keys.map(function(k) {
    return self.getOne(k);
  });

  return Q.allSettled(tasks)
    .then(function(results) {
      return results.map(function(r) {
        return r.value;
      });
    });
}

Storage.prototype.getAll = function() {
  return getFilesRecursive(this._folder);
}

Storage.prototype.putOne = function(key, value, options) {
  var self = this;
  options = options || {};

  if (options.overwrite) return this._overwrite(key, value);

  return this.exists(key)
    .then(function(exists) {
      if (exists) throw new Error('value for this key already exists in storage');

      return self._overwrite(key, value);
    });
}

Storage.prototype._overwrite = function(key, val) {
  var filePath = this.getAbsPathForKey(key);
  var dir = path.dirname(filePath);
  return Q.nfcall(mkdirp, dir)
    .then(function() {
      return writeFile(filePath, val);
    });
}

Storage.prototype.removeOne = function(key) {
  return unlink(this.getAbsPathForKey(key));
}

Storage.prototype.clear = function() {
  return rimraf(this._folder);
}

function getFilesRecursive(dir) {
  var deferred = Q.defer();
  var files = [];
  // Walker options
  var walker  = walk.walk(dir, { followLinks: false });
  walker.on('file', function(root, stat, next) {
    // Add this file to the list of files
    files.push(root + '/' + stat.name);
    next();
  });

  walker.on('errors', function (root, nodeStatsArray, next) {
    debug('failed to read file', nodeStatsArray);
    next();
  });

  walker.on('end', function() {
    deferred.resolve(files);
  });

  return deferred.promise;
}

module.exports = Storage;