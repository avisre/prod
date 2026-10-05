'use strict';
// Only reviewed inline-XBRL transformations. Unknown locale formats stay gaps.
function number({rawText,format,scale=0,sign}={}) {
 if(format && !/:(?:num(?:dotdecimal|-dot-decimal)|fixed-zero)$/i.test(format))return null;
 if(sign!==undefined && !['-','+'].includes(sign))return null;
 const exponent=Number(scale);if(!Number.isInteger(exponent) || Math.abs(exponent)>12)return null;
 const text=/fixed-zero$/.test(format || '')?'0':String(rawText || '').trim();
 if(!/^[+-]?(?:\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\.\d+)$/.test(text))return null;
 const result=Number(text.replace(/,/g,'')+'e'+exponent)*(sign==='-'?-1:1);return Number.isFinite(result)?result:null;
}
module.exports={number};
