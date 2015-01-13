
'use strict';

module.exports = function(grunt) {

  require('load-grunt-tasks')(grunt);

  grunt.registerTask('minify', ['closurecompiler:minify']);

  grunt.registerTask('default', [
    'jshint',
    'closurecompiler:minify'
  ]);

  // Project configuration.
  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),
    githooks: {
      all: {
        'pre-commit': 'jsbeautifier jshint closurecompiler:minify tape'
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
    },
    closurecompiler: {
      minify: {
        files: {
          // Destination: Sources...
          'bitkeeper-js.min.js': ['index.js', 'lib/**/*.js']
        },
        options: {
          // Any options supported by Closure Compiler, for example:
          'compilation_level': 'SIMPLE_OPTIMIZATIONS',

          // Plus a simultaneous processes limit
          'max_processes': 5,

          // And an option to add a banner, license or similar on top
          'banner': '/* Let\'s Tradle! */'
        }
      }
    }
  });

};