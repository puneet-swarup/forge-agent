// src/adapters/ollama-adapter.js - local Ollama daemon (localhost:11434)
'use strict';

const BaseAdapter = require('./base-adapter');
const logger = require('../logger');

class OllamaAdapter extends BaseAdapter {
 static DEDICATED_INSTANCE = true;

 constructor(page, config) {
 super(page, config || {});
 this._isFirstMessage = true;
 }

 get baseUrl() {
 const raw = process.env.OLLAMA_BASE_URL ||
 this.config.OLLAMA_BASE_URL ||
 'http://localhost:11434';
 let u = String(raw);
 while (u.endsWith('/')) u = u.slice(0, -1);
 return u;
 }

 get modelName() {
 return process.env.OLLAMA_MODEL ||
 this.config.OLLAMA_MODEL ||
 'deepseek-r1:8b';
 }

 _getInputSelectors() {
 return [
 'textarea#chat-input',
 'textarea',
 '[contenteditable="true"]',
 ];
 }
 _getSendSelectors() {
 return [
 'button[type="submit"]',
 '#send-button',
 'button:has(svg)',
 ];
 }

 _getStopSelectors() {
 return [
 '#stop-button',
 '[class=stop]',
 ];
 }

 _getNewChatSelectors() {
 return [
 '#new-chat',
 '[class=new-chat]',
 ];
 }

 _getResponseSelectors() {
 return [
 '.message.assistant',
 'div[class*=assistant]',
 'main',
 ];
 }

 _getUploadSelectors() {
 return ['input[type=file]'];
 }

 _getSendSelectors() {
 return [
 'button[type="submit"]',
 '#send-button',
 'button:has(svg)',
 ];
 }

 _getStopSelectors() {
 return [
 '#stop-button',
 '[class=stop]',
 ];
 }

 _getNewChatSelectors() {
 return [
 '#new-chat',
 '[class=new-chat]',
 ];
 }

 _getResponseSelectors() {
 return [
 '.message.assistant',
 'div[class*=assistant]',
 'main',
 ];
 }

 _getUploadSelectors() {
 return ['input[type=file]'];
 }

 getModelUrl() {
 return this.config.OLLAMA_UI_URL || this.baseUrl;
 }

 async isReady() {
 const input = await this._trySelectors(this._getInputSelectors(), {
 timeout: 5000,
 });
 return !!input;
 }

 // Reachability probe against the Ollama daemon. Never throws.
 async probe() {
 try {
 const res = await fetch(this.baseUrl + '/api/tags');
 if (!res.ok) return { ok: false, status: res.status };
 const body = await res.json();
 const names = Array.isArray(body.models)
 ? body.models.map(function (m) { return m.name; })
 : [];
 return { ok: true, models: names, requested: this.modelName };
 } catch (err) {
 logger.warn('[Ollama] probe failed: ' + err.message);
 return { ok: false, error: err.message };
 }
 }
}

module.exports = OllamaAdapter;
