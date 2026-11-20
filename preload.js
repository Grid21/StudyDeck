'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const call = (name) => (...a) => ipcRenderer.invoke(name, ...a);

contextBridge.exposeInMainWorld('studydeck', {
  info: call('app:info'),
  restart: call('app:restart'),
  openDataFolder: call('app:openDataFolder'),
  listPlugins: call('plugins:list'),
  openPluginsFolder: call('plugins:openFolder'),
  listDecks: call('decks:list'),
  importDecks: call('decks:import'),
  deleteDeck: call('decks:delete'),
  studyNext: call('study:next'),
  studyAnswer: call('study:answer'),
  progress: call('progress:get'),
  getSettings: call('settings:get'),
  setSettings: call('settings:set'),
  chooseUpdate: call('updates:choose'),
  installUpdate: call('updates:install'),
  removeUpdates: call('updates:remove'),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } }
});
