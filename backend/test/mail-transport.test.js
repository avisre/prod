'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const nodemailer=require('nodemailer');
test('patched mail transport preserves envelope, message identity and MIME without sending',async()=>{
 const transport=nodemailer.createTransport({streamTransport:true,buffer:true,newline:'unix'});
 const info=await transport.sendMail({from:'Support <support@example.invalid>',to:'Reader <reader@example.invalid>',replyTo:'reply@example.invalid',messageId:'<release-check@example.invalid>',subject:'Local release check',text:'Plain message',html:'<p>HTML message</p>',headers:{'List-Unsubscribe':'<https://example.invalid/unsubscribe>'}});
 assert.equal(info.messageId,'<release-check@example.invalid>');
 assert.deepEqual(info.envelope,{from:'support@example.invalid',to:['reader@example.invalid']});
 const mime=info.message.toString('utf8');
 assert.match(mime,/multipart\/alternative/);assert.match(mime,/Plain message/);assert.match(mime,/<p>HTML message<\/p>/);assert.match(mime,/List-Unsubscribe:/);assert.match(mime,/Reply-To: reply@example.invalid/);
 transport.close();
});
