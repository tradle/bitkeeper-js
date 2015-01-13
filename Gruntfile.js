
'use strict';

module.exports = function(grunt) {

  require('load-grunt-tasks')(grunt);

  grunt.registerTask('default', [
    'jshint'
  ]);

  // Project configuration.
  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),
    githooks: {
      all: {
        'pre-commit': 'jsbeautifier jshint'
      }
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