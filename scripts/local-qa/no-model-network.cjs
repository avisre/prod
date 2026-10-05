'use strict';
// Explicitly preload for deterministic financial QA. Local mocked model
// responses are allowed; requests to actual model providers are rejected.
const http=require('node:http'),https=require('node:https');
const providers=/(?:^|\.)(?:ollama\.com|openai\.com|anthropic\.com|groq\.com|openrouter\.ai|deepseek\.com|together\.xyz|together\.ai|fireworks\.ai)$|(?:^|\.)generativelanguage\.googleapis\.com$/i;
function forbidden(input){let u;try{u=new URL(typeof input==='string' || input instanceof URL?input:input?.url || ((input?.protocol || 'https:')+'//'+(input?.hostname || input?.host || '')+(input?.port?':'+input.port:'')+(input?.path || '/')));}catch(_){return false;}return providers.test(u.hostname) || (['localhost','127.0.0.1','::1'].includes(u.hostname) && u.port==='11434');}
function error(){return Object.assign(new Error('Actual model-provider requests are disabled during financial QA'),{code:'MODEL_NETWORK_DISABLED'});}
const originalFetch=globalThis.fetch;globalThis.fetch=function(input,...args){if(forbidden(input))return Promise.reject(error());return originalFetch.call(this,input,...args);};
for(const transport of [http,https])for(const name of ['request','get']){const original=transport[name];transport[name]=function(input,...args){if(forbidden(input))throw error();return original.call(this,input,...args);};}
module.exports={forbidden};
