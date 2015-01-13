
'use strict';

module.exports = function(grunt) {

  require('load-grunt-tasks')(grunt);

  grunt.registerTask('minify', ['closurecompiler:minify']);

  grunt.registerTask('default', [
    'jshint',
    'tape'
  ]);

  // Project configuration.
  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),
    githooks: {
      all: {
        'pre-commit': 'jsbeautifier jshint tape'
      }
    },

    tape: {
      options: {
        pretty: true,
        output: 'console'
      },
      files: ['test/**/*.js']
    },

    jsbeautifier: {
      options: {
        config: '.jsbeautifyrc'
      },

      default: {
        src: ['index.js', 'lib/**/*.js']
      },

      verify: {
        src: ['index.js', 'lib/**/*.js'],
        options: {
          mode: 'VERIFY_ONLY'
        }
      }
    },

    jshint: {
      options: {
        jshintrc: '.jshintrc'
      },

      gruntfile: {
        src: 'Gruntfile.js'
      },

      default: {
        src: ['Gruntfile.js', 'index.js', 'lib/**/*.js']
      }
    }
  });

};