require('dotenv').config();

const https = require("https");
const http = require("http");
const open = require("open");
const { RelayPool, calculateId, signId } = require('nostr');
const WebSocket = require('ws')
const { bech32 } = require('bech32')
const buffer = require('buffer')

https.get('https://nostr.watch/relays.json', (resp) => {
  let data = '';
  resp.on('data', (chunk) => data += chunk);
  resp.on('end', () => createPool(JSON.parse(data).relays));
}).on('error', (err) => console.log("Error: " + err.message));

let me = process.env.PUBKEY
if (me.startsWith('npub1')) me = npubtopubkey(me)

console.log(`Finding follow lists for ${me}`)

let follows = []
let entries = {}
let content = {}
let opened = []

function createPool(relays) {

  const pool = RelayPool(relays, {reconnect: false})
  
  pool.on('open', relay => {
    opened.push(relay.url)
    // console.log(`Open ${relay.url}`)
    relay.subscribe('sub', {kinds:[3], authors: [me]})
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

  setInterval(() => pool.relays.forEach(relay => {if (relay.ws && relay.ws.readyState === WebSocket.OPEN) relay.ws.ping()}), 10000)

  setTimeout(async () => {

    console.log(`Found ${follows.length} tags`)
    console.log(`Found ${Object.keys(content).length} relays`)

    let event = {
      pubkey: me,
      kind: 3,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify(content)
    }

    for (let pubkey of follows) {
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
        res.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Sign Nostr Event</title>
            <style>
              body { font-family: sans-serif; padding: 20px; text-align: center; }
              pre { text-align: left; background: #f0f0f0; padding: 10px; overflow-x: auto; }
              button { padding: 10px 20px; font-size: 1.2em; cursor: pointer; }
              .error { color: red; }
              .success { color: green; }
            </style>
          </head>
          <body>
            <h1>Sign Nostr Event</h1>
            <p>Please sign the following event using your browser extension (e.g., Alby, nos2x).</p>
            <button id="signBtn">Sign Event</button>
            <p id="status"></p>
            <pre id="eventDisplay">${JSON.stringify(event, null, 2)}</pre>
            <script>
              const event = ${JSON.stringify(event)};
              const btn = document.getElementById('signBtn');
              const status = document.getElementById('status');

              btn.onclick = async () => {
                try {
                  if (!window.nostr) {
                    throw new Error("No Nostr extension found! Please install Alby, nos2x, or similar.");
                  }
                  status.innerText = "Requesting signature...";
                  const signedEvent = await window.nostr.signEvent(event);
                  status.innerText = "Signed! Sending back to CLI...";
                  
                  await fetch('/signed', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(signedEvent)
                  });
                  
                  status.innerText = "Success! You can close this window.";
                  status.className = "success";
                  btn.disabled = true;
                } catch (err) {
                  console.error(err);
                  status.innerText = "Error: " + err.message;
                  status.className = "error";
                }
              };
            </script>
          </body>
          </html>
        `);
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
