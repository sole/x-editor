var gulp = require('gulp');
var jshint = require('gulp-jshint');
var rename = require('gulp-rename');
var browserify = require('gulp-browserify');

var DIST = './dist';

gulp.task('lint', function() {
  return gulp.src('src/js/**/*.js')
  .pipe(jshint())
  .pipe(jshint.reporter('default'));
});

gulp.task('build', ['build-js']);

gulp.task('build-js', function() {
  return gulp.src('src/js/main.js')
  .pipe(browserify({
    //insertGlobals: true,
    debug: !gulp.env.production // TODO fix to get rid of the deprecated notice
  }))
  .pipe(rename('x-editor.bundle.js'))
  .pipe(gulp.dest(DIST));
});


gulp.task('watch', function() {
  gulp.watch('src/**/*', ['lint', 'build']);
});

gulp.task('default', ['lint', 'build', 'watch']);
