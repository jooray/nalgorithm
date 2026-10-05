import { test } from 'node:test'
import assert from 'node:assert/strict'
import { domModule } from './dom-harness.mjs'
const post = (n, extra = {}) => ({ id: n.toString(16).padStart(64,'0'), author: 'a'.repeat(64), type:'original', createdAt:1000+n, score:8, content:'A thoughtful note', rawEvent:{kind:1,tags:[]}, ...extra })

test('unchanged cards and loaded video survive progressive score/profile changes', async () => {
  const {exports:r,document}=await domModule('src/render.ts');const container=document.getElementById('feed-list')
  r.renderFeed([post(1,{content:'https://cdn.example/video.mp4'})],container,{detail:false})
  const card=container.querySelector('.note');card.querySelector('.video-placeholder').click()
  const video=card.querySelector('video');assert.ok(video)
  r.renderFeed([post(1,{content:'https://cdn.example/video.mp4',score:9}),post(2)],container,{detail:false,profiles:new Map([['a'.repeat(64),{pubkey:'a'.repeat(64),name:'Alice'}]])})
  assert.equal(container.querySelector('.note'),card)
  assert.equal(card.querySelector('video'),video)
  assert.equal(card.querySelector('.author-link').textContent,'Alice')
  assert.equal(card.querySelector('.score-pill').textContent,'Score 9.0')
  r.clearFeed(container);assert.equal(container.childElementCount,0)
})

test('large feeds load in accessible chunks without rebuilding existing cards', async () => {
  const {exports:r,document}=await domModule('src/render.ts');const container=document.getElementById('feed-list')
  r.renderFeed(Array.from({length:120},(_,n)=>post(n+1)),container,{detail:false})
  const first=container.querySelector('.note');assert.equal(container.querySelectorAll('.note').length,50)
  container.querySelector('.feed-more').click()
  assert.equal(container.querySelectorAll('.note').length,100);assert.equal(container.querySelector('.note'),first)
})

test('rescoring while reading keeps reading order and truthful section headings', async () => {
  const {exports:r,document,window}=await domModule('src/render.ts');const container=document.getElementById('feed-list')
  window.HTMLElement.prototype.getBoundingClientRect ??= function () { return { top: 0, bottom: 10 } }
  const fresh=new Set([post(1).id,post(2).id])
  r.renderFeed([post(1),post(2),post(3),post(4)],container,{detail:false,fresh})
  window.scrollY=200
  r.renderFeed([post(4,{score:9.5}),post(2,{score:9}),post(1),post(3)],container,{detail:false,fresh})
  const ids=[...container.querySelectorAll('.note')].map((n)=>n.dataset.noteId)
  assert.deepEqual(ids,[post(1).id,post(2).id,post(3).id,post(4).id])
  assert.match(container.children[0].textContent,/New since last refresh · 2/)
  assert.equal(container.children[3].dataset.kind,'rest')
  assert.equal(container.querySelectorAll('.note-top').length,1)
  assert.ok(container.querySelector('.note-top').dataset.noteId===post(4).id)
  // A different "new" set is a refresh: laid out afresh even while scrolled.
  r.renderFeed([post(4,{score:9.5}),post(2,{score:9}),post(1),post(3)],container,{detail:false,fresh:new Set([post(3).id])})
  assert.equal(container.querySelectorAll('.note')[0].dataset.noteId,post(3).id)
})

test('show next moves focus to the first newly shown note', async () => {
  const {exports:r,document,window}=await domModule('src/render.ts');const container=document.getElementById('feed-list')
  let focused=null
  window.HTMLElement.prototype.focus=function(){focused=this}
  r.renderFeed(Array.from({length:60},(_,n)=>post(n+1)),container,{detail:false})
  container.querySelector('.feed-more').click()
  assert.equal(container.querySelectorAll('.note').length,60)
  assert.equal(focused,container.querySelectorAll('.note')[50])
  assert.equal(container.querySelector('.feed-more'),null)
})

test('images keep their proportions and description, and data saver requests nothing until asked', async () => {
  const {exports:r,document}=await domModule('src/render.ts');const container=document.getElementById('feed-list')
  const tags=[['imeta','url https://img.example/tall.png','dim 600x1800','alt A long comic strip']]
  r.renderFeed([post(1,{content:'look',rawEvent:{kind:1,tags}}),post(2,{content:'hosted',media:[{url:'https://img.example/h.jpg',width:4,height:3}]})],container,{detail:false})
  const imgs=container.querySelectorAll('img:not([aria-hidden])')
  const tall=[...container.querySelectorAll('.post-image img')]
  assert.equal(tall.length,2,'tag-only media shows in both modes')
  assert.equal(tall[0].getAttribute('alt'),'A long comic strip')
  assert.equal(tall[0].getAttribute('width'),'600');assert.equal(tall[0].getAttribute('height'),'1800')
  assert.equal(tall[1].getAttribute('alt'),'Image without a description')
  assert.ok(imgs.length>=2)
  r.renderFeed([post(1,{content:'look',rawEvent:{kind:1,tags}})],container,{detail:false,dataSaver:true})
  assert.equal(container.querySelectorAll('.post-image img').length,0,'nothing requested from the image host')
  const placeholder=container.querySelector('.media-placeholder')
  assert.match(placeholder.textContent,/Load image: A long comic strip/)
  placeholder.click()
  assert.equal(container.querySelectorAll('.post-image img').length,1)
})

test('best order while reading: nothing moves above the read note, new scores are placed below it', async () => {
  const {exports:r,document,window}=await domModule('src/render.ts');const container=document.getElementById('feed-list')
  window.HTMLElement.prototype.getBoundingClientRect ??= function () { return { top: 0, bottom: 10 } }
  r.renderFeed([post(1,{score:9}),post(2,{score:8}),post(3,{score:7})],container,{detail:false,feedOrder:'best'})
  window.scrollY=200
  r.renderFeed([post(1,{score:9}),post(4,{score:8.5}),post(3,{score:7}),post(2,{score:6})],container,{detail:false,feedOrder:'best'})
  const ids=[...container.querySelectorAll('.note')].map((n)=>n.dataset.noteId)
  assert.deepEqual(ids,[post(1).id,post(4).id,post(2).id,post(3).id])
})
