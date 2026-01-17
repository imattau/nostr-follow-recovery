# nostr-follow-recovery

Simple tool to recover lost follows on Nostr.

# Why?

Sometimes you lose a chunk of follows, due to mis-handling of clients. This tool tries to recover those follows.

# How?

It tries to connect to all relays from nostr.watch, fetches the kind 3 event of the specified pubkey and aggregates all follows. It also aggregates the relays mentioned and take into account which relays you have configured as writable.

You can also add your private key - do this at your own risk. If you do, it will sign the event and broadcast the new kind 3 event to all your writable relays that responded.

# Usage

Edit the `.env` file and fill in your pubkey (hex or npub format).

### Signing Options

1. **Local Key**: Fill in your private key (hex format) in the `.env` file. **Use at your own risk.**
2. **Browser Extension (NIP-07)**: Leave `PRIVKEY` empty. When you run the script, it will automatically open your browser to a local page where you can sign with extensions like Alby or nos2x.
3. **Mobile Signer (NIP-46)**: Leave `PRIVKEY` empty. In the browser page that opens, switch to the "Mobile" tab and scan the QR code with a compatible signer (e.g., Amber, Keystone).

Install dependencies:

`npm install`

and run:

`node recovery.js`

It takes about 40 seconds to collect data, then it will prompt you for a signature if no local key is found.

# Notes:

It will probably also restore follows from pubkeys you previously unfollowed if those follows exist in older Kind 3 events on some relays.

This is not battletested. It worked for me, after I lost 75% of my follows.

# Cause

One of the things I suspect caused my loss of follows was that one client 'forgot' about all the follows in the kind 3 event which didn't have a relay attached. I have not tracked down which client this is, I'm using a whole set of different Nostr clients and am unable to reproduce the issue.