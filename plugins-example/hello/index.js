'use strict';
exports.activate = function (studydeck) {
  studydeck.log('Hello from the example plugin!');
  studydeck.on('app:ready', () => studydeck.log('The app is ready.'));
};
