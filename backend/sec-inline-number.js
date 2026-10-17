'use strict';
// Only reviewed inline-XBRL transformations. Unknown locale formats stay gaps.
function number({rawText,format,scale=0,sign}={}) {
 if(format && !/:(?:num(?:dotdecimal|-dot-decimal|-comma-decimal)|fixed-zero)$/i.test(format))return null;
 if(sign!==undefined && !['-','+'].includes(sign))return null;
 const exponent=Number(scale);if(!Number.isInteger(exponent) || Math.abs(exponent)>12)return null;
 let text=/fixed-zero$/.test(format || '')?'0':String(rawText || '').trim();
 // Anheuser-Busch InBev's 20-F writes 1.234,5: a point or space between thousands, a decimal comma.
 if(/num-comma-decimal$/i.test(format || '')){if(!/^[+-]?(?:\d+|\d{1,3}(?:\.\d{3})+|\d{1,3}(?: \d{3})+)(?:,\d+)?$/.test(text))return null;text=text.replace(/[. ]/g,'').replace(',','.');}
 if(!/^[+-]?(?:\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\.\d+)$/.test(text))return null;
 const result=Number(text.replace(/,/g,'')+'e'+exponent)*(sign==='-'?-1:1);return Number.isFinite(result)?result:null;
}
module.exports={number};
