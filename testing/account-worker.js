// Controlled account-host fixture for policy/Keychain lifecycle tests. No live OAuth.
import readline from 'node:readline';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
const file = join(process.env.XDG_CONFIG_HOME, 'fixture.json');
let signedIn = false;
let outcome;
try {
  signedIn = JSON.parse(readFileSync(file, 'utf8')).signedIn;
} catch {}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { operation } = JSON.parse(line);
  let result = {};
  if (operation === 'login') {
    if (!existsSync(join(process.env.XDG_CONFIG_HOME, 'hold-login'))) {
      signedIn = true;
      outcome = 'granted';
    }
    result = {
      verificationUrl: 'https://auth.meta.com/oauth/device/?code=FIXT-TEST',
      userCode: 'FIXT-TEST',
    };
  }
  if (operation === 'cancel' && existsSync(join(process.env.XDG_CONFIG_HOME, 'fail-cancel'))) {
    unlinkSync(join(process.env.XDG_CONFIG_HOME, 'fail-cancel'));
    process.stdout.write(JSON.stringify({ error: 'Fixture cancellation failure' }) + '\n');
    return;
  }
  if (operation === 'logout') throw Error('App-local logout must not revoke Muse credentials');
  if (operation === 'read')
    result = {
      account: {
        state: signedIn ? 'accountLogin' : 'loggedOut',
        label: signedIn ? 'Fixture subscription' : undefined,
        credentialRequired: true,
      },
      outcome,
    };
  writeFileSync(file, JSON.stringify({ signedIn }));
  process.stdout.write(JSON.stringify({ result }) + '\n');
});
