require('dotenv').config();

const https = require("https");
const http = require("http");
const open = require("open");
const { RelayPool, calculateId, signId } = require('nostr');
const WebSocket = require('ws')
const { bech32 } = require('bech32')
const buffer = require('buffer')

const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
  "wss://nos.lol",
  "wss://nostr.mom",
  "wss://relay.primal.net",
  "wss://purplepag.es"
];

let follows = []
let muted = []
let entries = {}
let content = {}
let opened = []

(async () => {
  let me = process.env.PUBKEY
  if (!me) {
    console.log("PUBKEY not found in .env. Launching browser to login...");
    try {
      me = await getPublicKeyFromBrowser();
      console.log("Received public key:", me);
    } catch (err) {
      console.error("Failed to get public key:", err);
      process.exit(1);
    }
  }
  if (me.startsWith('npub1')) me = npubtopubkey(me)

  console.log(`Finding follow lists for ${me}`)

  createPool(DEFAULT_RELAYS, me);
})();

function createPool(relays, me) {

  const pool = RelayPool(relays, {reconnect: false})
  
  pool.on('open', relay => {
    opened.push(relay.url)
    // console.log(`Open ${relay.url}`)
    relay.subscribe('sub', {kinds:[3, 10000], authors: [me]})
  });

  pool.on('notice', (relay, notice) => {
    console.log(`Notice ${relay.url}: ${notice}`)
  });

  pool.on('close', (relay, e) => {
    // console.log(`Close ${relay.url}: Code ${e.code} ${e.reason}`)
  });
  
  pool.on('error', (relay, e) => {
    console.log(`Error ${relay.url}: ${e.message}`)
  });
  
  pool.on('eose', (relay, sub_id) => {
    // console.log(`EOSE ${relay.url}`)
  });
  
  pool.on('event', (relay, sub_id, event) => {
    if (event.kind === 10000) {
      for (let tag of event.tags) {
        if (tag[0] === 'p') {
          muted.push(tag[1])
        }
      }
      return
    }

    if (event.content && event.content.length > 0) {
      for (let [relay, state] of Object.entries(JSON.parse(event.content))) {
        if (!content[relay]) {
          content[relay] = state
        }
      }
    }
    
    let count = 0
    for (let tag of event.tags) {
      let pubkey = tag[1]
      if (!follows.includes(pubkey)) {
        count++
        follows.push(pubkey)
        let entry = {pubkey: pubkey}
        if (tag.length > 2) {
          entry.relay = tag[2]
          entry.created_at = event.created_at
        }
        entries[pubkey] = entry
      } else {
        let entry = entries[pubkey]
        if (tag.length > 2) {
          let relay = tag[2]
          if (!entry.relay) {
            entry.relay = relay
          } else {
            if (entry.created_at < event.created_at) {
              entry.created_at = event.created_at
              entry.relay = relay
            }
          }
        }
      }
    }

    console.log(`Found ${event.tags.length} tags on ${relay.url}, added ${count}`)
  });

  setInterval(() => pool.relays.forEach(relay => {
    if (relay.ws && relay.ws.readyState === WebSocket.OPEN && typeof relay.ws.ping === 'function') {
      relay.ws.ping();
    }
  }), 10000)

  setTimeout(async () => {

    console.log(`Found ${follows.length} tags`)
    console.log(`Found ${muted.length} muted`)
    console.log(`Found ${Object.keys(content).length} relays`)

    let event = {
      pubkey: me,
      kind: 3,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify(content)
    }

    for (let pubkey of follows) {
      if (muted.includes(pubkey)) continue
      let entry = entries[pubkey]
      if (entry.relay) {
        event.tags.push(['p', entry.pubkey, entry.relay])
      } else {
        event.tags.push(['p', entry.pubkey])
      }
    }

    event.id = await calculateId(event)

    let signedEvent = null;

    if (process.env.PRIVKEY) {
      event.sig = await signId(process.env.PRIVKEY, event.id)
      signedEvent = event;
    } else {
      console.log("No private key found in env. Attempting to sign via browser...");
      try {
        signedEvent = await getSignatureFromBrowser(event);
      } catch (err) {
        console.error("Failed to get signature:", err);
        process.exit(1);
      }
    }

    console.log(JSON.stringify(signedEvent))

    let writeRelays = []
    for (let [relay, stats] of Object.entries(content)) {
      if (opened.includes(relay) && stats.write) {
        writeRelays.push(relay)
      }
    }

    for (let relay of pool.relays) {
      if (writeRelays.includes(relay.url) && relay.ws && relay.ws.readyState === 1) {
        console.log(`Sending to ${relay.url}`)
        await relay.send(["EVENT", signedEvent])
      }
    }
    
    // Wait a bit for responses
    setTimeout(() => {
      console.log(`finished`)

      process.exit(0)
    }, 10000)
  }, 30000)
}

function npubtopubkey(npub) {
  if (!npub.startsWith('npub') || npub.length < 60) return null
  let decoded = bech32.fromWords( bech32.decode( npub ).words );
  return buffer.Buffer.from( decoded ).toString( 'hex' )
}

function getSignatureFromBrowser(event) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        const html = `
          <!DOCTYPE html>
          <html>
          <head>
            <title>Sign Nostr Event</title>
            <script src="https://unpkg.com/nostr-tools/lib/nostr.bundle.js"></script>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
            <style>
              body { font-family: sans-serif; padding: 20px; text-align: center; max-width: 800px; margin: 0 auto; }
              pre { text-align: left; background: #f0f0f0; padding: 10px; overflow-x: auto; font-size: 0.8em; }
              button { padding: 10px 20px; font-size: 1.2em; cursor: pointer; margin: 10px; }
              .error { color: red; }
              .success { color: green; }
              .tab { display: none; padding: 20px; border: 1px solid #ccc; border-radius: 5px; margin-top: 20px; }
              .tab.active { display: block; }
              .tabs-nav button { background: #eee; border: 1px solid #ccc; border-bottom: none; }
              .tabs-nav button.active { background: #fff; font-weight: bold; }
              #qrcode { margin: 20px auto; display: flex; justify-content: center; }
            </style>
          </head>
          <body>
            <h1>Sign Nostr Event</h1>
            
            <div class="tabs-nav">
              <button onclick="switchTab('extension')" id="btn-extension" class="active">Browser Extension</button>
              <button onclick="switchTab('mobile')" id="btn-mobile">Mobile (NIP-46)</button>
            </div>

            <div id="tab-extension" class="tab active">
              <p>Sign using Alby, nos2x, or other browser extensions.</p>
              <button id="signBtnExtension">Sign with Extension</button>
            </div>

            <div id="tab-mobile" class="tab">
              <p>Scan with a NIP-46 compatible signer (e.g., Amber, Keystone).</p>
              <div id="qrcode"></div>
              <p id="nip46-status">Waiting for connection...</p>
            </div>

            <p id="status"></p>
            <pre id="eventDisplay">${JSON.stringify(event, null, 2)}</pre>

            <script>
              const eventToSign = __EVENT_JSON__;
              const status = document.getElementById('status');
              
              // --- Utils ---
              async function sendSigned(signedEvent) {
                status.innerText = "Signed! Sending back to CLI...";
                await fetch('/signed', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(signedEvent)
                });
                status.innerText = "Success! You can close this window.";
                status.className = "success";
                document.querySelectorAll('button').forEach(b => b.disabled = true);
              }

              function switchTab(tab) {
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.getElementById('tab-' + tab).classList.add('active');
                document.querySelectorAll('.tabs-nav button').forEach(b => b.classList.remove('active'));
                document.getElementById('btn-' + tab).classList.add('active');
                if (tab === 'mobile') initNip46();
              }

              // --- Extension Signing ---
              document.getElementById('signBtnExtension').onclick = async () => {
                try {
                  if (!window.nostr) throw new Error("No Nostr extension found!");
                  status.innerText = "Requesting signature...";
                  const signed = await window.nostr.signEvent(eventToSign);
                  await sendSigned(signed);
                } catch (err) {
                  console.error(err);
                  status.innerText = "Error: " + err.message;
                  status.className = "error";
                }
              };

              // --- NIP-46 Mobile Signing ---
              let nip46Init = false;
              async function initNip46() {
                if (nip46Init) return;
                nip46Init = true;
                
                const tools = window.NostrTools;
                const relayUrl = 'wss://relay.nsec.app';
                const sk = tools.generatePrivateKey();
                const pk = tools.getPublicKey(sk);
                const secret = Math.random().toString(36).substring(2, 15);
                
                const uri = \`nostrconnect://\${pk}?relay=\${encodeURIComponent(relayUrl)}&metadata=\${encodeURIComponent(JSON.stringify({name: "Nostr Follow Recovery"}))}&secret=\${secret}\`;
                
                new QRCode(document.getElementById("qrcode"), uri);
                
                const pool = new tools.SimplePool();
                const sub = pool.subscribeMany([relayUrl], [{ kinds: [24133], '#p': [pk] }], {
                  onevent: async (msg) => {
                    try {
                      const content = JSON.parse(msg.content);
                      
                      // Handle 'connect' request from Signer
                      if (content.method === 'connect') {
                         document.getElementById('nip46-status').innerText = "Connected! Requesting signature...";
                         const signerPubkey = content.params[0];
                         
                         // Reply 'connect' success
                         const replyConnect = {
                           kind: 24133,
                           created_at: Math.floor(Date.now() / 1000),
                           tags: [['p', signerPubkey]],
                           content: JSON.stringify({ id: content.id, result: "ack", error: null })
                         };
                         replyConnect.pubkey = pk;
                         replyConnect.id = tools.getEventHash(replyConnect);
                         replyConnect.sig = tools.getSignature(replyConnect, sk);
                         await pool.publish([relayUrl], replyConnect);

                         // Request 'sign_event'
                         const reqId = Math.random().toString();
                         const signReq = {
                           kind: 24133,
                           created_at: Math.floor(Date.now() / 1000),
                           tags: [['p', signerPubkey]],
                           content: JSON.stringify({
                             id: reqId,
                             method: "sign_event",
                             params: [JSON.stringify(eventToSign)]
                           })
                         };
                         signReq.pubkey = pk;
                         signReq.id = tools.getEventHash(signReq);
                         signReq.sig = tools.getSignature(signReq, sk);
                         await pool.publish([relayUrl], signReq);
                      }
                      
                      // Handle 'sign_event' response
                      if (content.result && typeof content.result === 'string') {
                         // Check if result looks like JSON event or just signature?
                         // NIP-46 sign_event returns JSON string of signed event object
                         const signedEvt = JSON.parse(content.result);
                         if (signedEvt.sig) {
                            pool.close(sub);
                            await sendSigned(signedEvt);
                         }
                      }
                    } catch (e) {
                      console.error("NIP-46 Error:", e);
                    }
                  }
                });
              }
            </script>
          </body>
          </html>
        `;
        res.end(html.replace('__EVENT_JSON__', JSON.stringify(event)));
      } else if (req.method === 'POST' && req.url === '/signed') {
        let body = '';
        req.on('data', chunk => {
          body += chunk.toString();
        });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('Received');
          server.close();
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(0, 'localhost', async () => {
      const port = server.address().port;
      const url = `http://localhost:${port}`;
      console.log(`Opening browser at ${url} to sign event...`);
      await open(url);
    });
  });
}

function getPublicKeyFromBrowser() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Login to Nostr Follow Recovery</title>
            <script src="https://unpkg.com/nostr-tools/lib/nostr.bundle.js"></script>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
            <style>
              body { font-family: sans-serif; padding: 20px; text-align: center; max-width: 800px; margin: 0 auto; }
              button { padding: 10px 20px; font-size: 1.2em; cursor: pointer; margin: 10px; }
              .error { color: red; }
              .success { color: green; }
              .tab { display: none; padding: 20px; border: 1px solid #ccc; border-radius: 5px; margin-top: 20px; }
              .tab.active { display: block; }
              .tabs-nav button { background: #eee; border: 1px solid #ccc; border-bottom: none; }
              .tabs-nav button.active { background: #fff; font-weight: bold; }
              #qrcode { margin: 20px auto; display: flex; justify-content: center; }
            </style>
          </head>
          <body>
            <h1>Login</h1>
            <p>Please provide your public key to start recovering follows.</p>

            <div class="tabs-nav">
              <button onclick="switchTab('extension')" id="btn-extension" class="active">Browser Extension</button>
              <button onclick="switchTab('mobile')" id="btn-mobile">Mobile (NIP-46)</button>
            </div>

            <div id="tab-extension" class="tab active">
              <p>Login using Alby, nos2x, or other browser extensions.</p>
              <button id="loginBtnExtension">Get Public Key</button>
            </div>

            <div id="tab-mobile" class="tab">
              <p>Scan with a NIP-46 compatible signer (e.g., Amber, Keystone).</p>
              <div id="qrcode"></div>
              <p id="nip46-status">Waiting for connection...</p>
            </div>

            <p id="status"></p>

            <script>
              const status = document.getElementById('status');
              
              async function sendPubkey(pubkey) {
                status.innerText = "Received " + pubkey + "! Sending back to CLI...";
                await fetch('/pubkey', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ pubkey })
                });
                status.innerText = "Success! You can close this window.";
                status.className = "success";
                document.querySelectorAll('button').forEach(b => b.disabled = true);
              }

              function switchTab(tab) {
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.getElementById('tab-' + tab).classList.add('active');
                document.querySelectorAll('.tabs-nav button').forEach(b => b.classList.remove('active'));
                document.getElementById('btn-' + tab).classList.add('active');
                if (tab === 'mobile') initNip46();
              }

              // --- Extension Login ---
              document.getElementById('loginBtnExtension').onclick = async () => {
                try {
                  if (!window.nostr) throw new Error("No Nostr extension found!");
                  status.innerText = "Requesting public key...";
                  const pubkey = await window.nostr.getPublicKey();
                  await sendPubkey(pubkey);
                } catch (err) {
                  console.error(err);
                  status.innerText = "Error: " + err.message;
                  status.className = "error";
                }
              };

              // --- NIP-46 Mobile Login ---
              let nip46Init = false;
              async function initNip46() {
                if (nip46Init) return;
                nip46Init = true;
                
                const tools = window.NostrTools;
                const relayUrl = 'wss://relay.nsec.app';
                const sk = tools.generatePrivateKey();
                const pk = tools.getPublicKey(sk);
                const secret = Math.random().toString(36).substring(2, 15);
                
                const uri = \`nostrconnect://\${pk}?relay=\${encodeURIComponent(relayUrl)}&metadata=\${encodeURIComponent(JSON.stringify({name: "Nostr Follow Recovery Login"}))}&secret=\${secret}\`;
                
                new QRCode(document.getElementById("qrcode"), uri);
                
                const pool = new tools.SimplePool();
                const sub = pool.subscribeMany([relayUrl], [{ kinds: [24133], '#p': [pk] }], {
                  onevent: async (msg) => {
                    try {
                      const content = JSON.parse(msg.content);
                      
                      // Handle 'connect' request from Signer
                      if (content.method === 'connect') {
                         document.getElementById('nip46-status').innerText = "Connected! Requesting public key...";
                         const signerPubkey = content.params[0];
                         
                         // Reply 'connect' success
                         const replyConnect = {
                           kind: 24133,
                           created_at: Math.floor(Date.now() / 1000),
                           tags: [['p', signerPubkey]],
                           content: JSON.stringify({ id: content.id, result: "ack", error: null })
                         };
                         replyConnect.pubkey = pk;
                         replyConnect.id = tools.getEventHash(replyConnect);
                         replyConnect.sig = tools.getSignature(replyConnect, sk);
                         await pool.publish([relayUrl], replyConnect);

                         // We already have the signer's pubkey from the connect params!
                         // But to be polite/standard we could ask for get_public_key, 
                         // but 'connect' already gives it.
                         pool.close(sub);
                         await sendPubkey(signerPubkey);
                      }
                    } catch (e) {
                      console.error("NIP-46 Error:", e);
                    }
                  }
                });
              }
            </script>
          </body>
          </html>
        `);
      } else if (req.method === 'POST' && req.url === '/pubkey') {
        let body = '';
        req.on('data', chunk => {
          body += chunk.toString();
        });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('Received');
          server.close();
          try {
            resolve(JSON.parse(body).pubkey);
          } catch (e) {
            reject(e);
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(0, 'localhost', async () => {
      const port = server.address().port;
      const url = `http://localhost:${port}`;
      console.log(`Opening browser at ${url} to login...`);
      await open(url);
    });
  });
}