
function replace(module, replacement) {
  for (var p in replacement) {
    if (replacement.hasOwnProperty(p)) {
      var val = replacement[p]
      if (typeof val === 'function') module[p] = replacement[p].bind(replacement)
      else module[p] = val
    }
  }
}

module.exports = replace;
