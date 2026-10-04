/**
 * Browser walkthrough with three simultaneous users (separate browser
 * contexts), driving the real UI. Fails on any console error or page crash.
 *
 *   BASE_URL=http://localhost:3000 npx tsx scripts/ui-walkthrough.ts [screenshot-dir]
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';

const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const OUT = process.argv[2] ?? path.join(import.meta.dirname, '..', 'test-results', 'ui');
const fixture = (n: string) => path.join(import.meta.dirname, '..', 'tests', 'fixtures', 'images', n);
fs.mkdirSync(OUT, { recursive: true });

const problems: string[] = [];
const log = (m: string) => console.log(`  ✓ ${m}`);

async function main() {
  const browser = await chromium.launch();
  const open = async (name: string, viewport = { width: 420, height: 880 }) => {
    const page = await (await browser.newContext({ viewport })).newPage();
    page.on('console', (m) => m.type() === 'error' && problems.push(`[${name}] console: ${m.text()}`));
    page.on('pageerror', (e) => problems.push(`[${name}] pageerror: ${e.message}`));
    return page;
  };
  const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

  // Host creates the session through the form
  const host = await open('host', { width: 900, height: 900 });
  await host.goto(BASE);
  await shot(host, '01-home');
  await host.getByLabel('Session name').fill('Friday quiz');
  await host.locator('#host-name').fill('Alex');
  await host.getByRole('button', { name: 'Create session' }).click();
  await host.waitForURL(/\/s\/[A-Z0-9]{6}$/);
  const code = host.url().split('/').pop()!;
  await host.getByText('Waiting room').waitFor();
  await host.getByAltText(`QR code to join session ${code}`).waitFor(); // invite card with QR
  log(`host created session ${code} and is in the waiting room`);

  // A joins from the home page, B from a shared link
  const a = await open('A');
  await a.goto(BASE);
  await a.getByLabel('Session code').fill(code.toLowerCase());
  await a.locator('#join-display-name').fill('Sam');
  await a.getByRole('button', { name: 'Join session' }).click();
  await a.getByText('The host will start the session shortly').waitFor();
  const b = await open('B');
  await b.goto(`${BASE}/s/${code}`);
  await b.getByLabel('Your name').fill('Riya');
  await b.getByRole('button', { name: 'Join session' }).click();
  await b.getByText('The host will start the session shortly').waitFor();
  await host.getByText('Participants (3)').waitFor(); // live, no reload
  await shot(host, '02-waiting-room-host');
  log('two participants joined; the host waiting room updated live');

  await host.getByRole('button', { name: 'Start session' }).click();
  await a.getByRole('button', { name: 'Post answer' }).waitFor(); // participants move on without reloading
  await b.getByRole('button', { name: 'Post answer' }).waitFor();
  log('host started; participants moved to the Play tab without reloading');

  // chat: public to everyone, private to one person
  await a.getByRole('button', { name: 'Chat', exact: true }).click();
  await a.getByLabel('Message to everyone').fill('Hello all, ready?');
  await a.getByLabel('Message to everyone').press('Enter');
  await a.getByRole('complementary', { name: 'Chat' }).getByText('Hello all, ready?').waitFor();
  await b.getByRole('button', { name: 'Chat, 1 unread' }).click(); // badge arrived live
  const bChat = b.getByRole('complementary', { name: 'Chat' });
  await bChat.getByText('Hello all, ready?').waitFor();
  await bChat.getByRole('list').getByText('Sam', { exact: true }).waitFor(); // sender name on the message
  await b.getByRole('button', { name: 'Chat', exact: true }).waitFor({ state: 'attached' }); // reading cleared the badge
  await b.getByLabel('To', { exact: true }).selectOption({ label: 'Sam' });
  await bChat.getByText('Only you and Sam can see this conversation.').waitFor();
  await b.getByLabel('Private message to Sam').fill('Sam, just between us: I think it is a labrador');
  await b.getByRole('button', { name: 'Send' }).click();
  await bChat.getByText('just between us').waitFor();
  await shot(b, '03a-chat-private');
  // Sam is looking at "Everyone": the private message shows up as unread on the selector, not in the public thread
  const aChat = a.getByRole('complementary', { name: 'Chat' });
  await a.getByLabel('To', { exact: true }).locator('option', { hasText: 'Riya (1 new)' }).waitFor({ state: 'attached' });
  if (await aChat.getByText('just between us').count()) throw new Error('a private message appeared in the public thread');
  await a.getByLabel('To', { exact: true }).selectOption({ label: 'Riya (1 new)' });
  await aChat.getByText('just between us').waitFor();
  await a.getByLabel('Private message to Riya').fill('Noted 🤫');
  await a.getByLabel('Private message to Riya').press('Enter');
  await bChat.getByText('Noted 🤫').waitFor(); // B has that conversation open: arrives live
  // the host sees the public message only
  await host.getByRole('button', { name: 'Chat, 1 unread' }).click();
  const hostChat = host.getByRole('complementary', { name: 'Chat' });
  await hostChat.getByText('Hello all, ready?').waitFor();
  for (const name of ['Sam', 'Riya']) {
    await host.getByLabel('To', { exact: true }).selectOption({ label: name });
    await hostChat.getByText(`No messages with ${name} yet.`).waitFor();
  }
  if (await hostChat.getByText('just between us').count()) throw new Error('the host can see a private message');
  await shot(host, '03b-chat-host');
  await host.getByRole('button', { name: 'Close chat' }).click();
  // history survives a refresh
  await b.reload();
  await b.getByRole('button', { name: 'Chat', exact: true }).click();
  await b.getByLabel('To', { exact: true }).selectOption({ label: 'Sam' });
  await b.getByRole('complementary', { name: 'Chat' }).getByText('Noted 🤫').waitFor();
  await b.getByRole('button', { name: 'Close chat' }).click();
  await a.getByRole('button', { name: 'Close chat' }).click();
  // start a private chat straight from the participant list
  await a.getByTitle('Participants').click();
  await a.getByRole('button', { name: 'Message Alex privately' }).click();
  await a.getByRole('complementary', { name: 'Chat' }).getByText('Only you and Alex can see this conversation.').waitFor();
  await a.getByRole('button', { name: 'Close chat' }).click();
  log('chat: public message reached everyone live; private messages reached only the two people; history survives refresh');

  // home page list → ask to join → host admits / declines
  const visitor = await open('visitor');
  await visitor.goto(BASE);
  const row = visitor.getByRole('listitem').filter({ hasText: 'Friday quiz' }).filter({ hasText: 'Hosted by Alex' }).last();
  await row.getByText('In progress').waitFor();
  if ((await visitor.content()).includes(code)) throw new Error('the session code is exposed on the home page');
  await row.getByRole('button', { name: 'Ask to join Friday quiz' }).click();
  await row.getByLabel('Your name').fill('Vik');
  await row.getByRole('button', { name: 'Send request' }).click();
  await visitor.getByText('to let you in as').waitFor();
  await shot(visitor, '03c-home-waiting');
  await visitor.reload(); // still in the queue after a refresh
  await visitor.getByText('to let you in as').waitFor();
  const asking = host.getByRole('region', { name: 'People asking to join' });
  await asking.getByText('Vik').waitFor(); // appeared live for the host
  if (await a.getByRole('region', { name: 'People asking to join' }).count()) throw new Error('a participant can see join requests');
  await shot(host, '03d-host-join-request');
  await asking.getByRole('button', { name: 'Admit Vik' }).click();
  await visitor.waitForURL(new RegExp(`/s/${code}$`)); // moved into the session by itself
  await visitor.getByRole('button', { name: 'Post answer' }).waitFor();
  await asking.waitFor({ state: 'hidden' });
  // a second visitor is declined
  const stranger = await open('stranger');
  await stranger.goto(BASE);
  const row2 = stranger.getByRole('listitem').filter({ hasText: 'Friday quiz' }).filter({ hasText: 'Hosted by Alex' }).last();
  await row2.getByRole('button', { name: 'Ask to join Friday quiz' }).click();
  await row2.getByLabel('Your name').fill('Zed');
  await row2.getByRole('button', { name: 'Send request' }).click();
  await host.getByRole('button', { name: 'Decline Zed' }).click();
  await stranger.getByText('The host declined your request to join “Friday quiz”.').waitFor();
  await stranger.close();
  log('home page lists the session; a visitor asked to join, the host admitted them live; another was declined');

  // the host removes someone: they are cut off at once, without reloading
  await host.getByTitle('Participants').click();
  await host.getByRole('button', { name: 'Remove Vik from the session' }).click();
  await shot(host, '03e-remove-confirm');
  await host.getByRole('button', { name: 'Remove Vik', exact: true }).click();
  await visitor.getByText('You were removed from this session').waitFor();
  await shot(visitor, '03f-removed');
  await host.getByRole('button', { name: 'Remove Vik from the session' }).waitFor({ state: 'detached' });
  if (await host.getByRole('button', { name: /Remove Alex/ }).count()) throw new Error('the host is offered to remove themselves');
  await host.getByTitle('Participants').click();
  if (await a.getByRole('button', { name: /^Remove / }).count()) throw new Error('a participant can see Remove buttons');
  await visitor.close();
  log('host removed a participant; they were shown out immediately');

  // B watches the Questions tab while A posts
  await b.getByRole('button', { name: 'Questions', exact: true }).click();
  await b.getByText('No questions yet.').waitFor();
  await a.locator('input[type=file]').first().setInputFiles(fixture('golden-1.jpg'));
  await a.getByLabel('Your answer').fill('Golden Retriever');
  await shot(a, '03-play-tab-filled');
  await a.getByRole('button', { name: 'Post answer' }).click();
  await a.getByText('Question #1 created.').waitFor({ timeout: 30000 });
  await b.getByRole('heading', { name: 'Question #1' }).waitFor();
  await shot(b, '04-questions-tab-live');
  log('A posted; Question #1 appeared live in B\'s Questions tab');

  // B posts a different photo of the same subject
  await b.getByRole('button', { name: 'Play', exact: true }).click();
  await b.locator('input[type=file]').first().setInputFiles(fixture('golden-2.jpg'));
  await b.getByLabel('Your answer').fill('Labrador');
  await b.getByRole('button', { name: 'Post answer' }).click();
  const dialog = b.getByRole('dialog');
  await dialog.getByText('This content has already been posted as').waitFor({ timeout: 30000 });
  await dialog.getByText('Golden Retriever', { exact: true }).waitFor();
  await shot(b, '05-match-dialog');
  log('B posted a different photo; the "already exists" dialog shows A\'s answer');

  // refresh mid-decision: the dialog must come back
  await b.reload();
  await b.getByRole('dialog').getByText('Do you agree with the previous answer?').waitFor();
  log('after a page refresh the pending decision is restored');

  await b.getByRole('button', { name: 'Challenge this answer' }).click();
  await b.getByLabel(/Why do you disagree/).fill('This looks more like a Labrador.');
  await b.getByRole('button', { name: 'Challenge answer' }).click();
  await b.getByRole('dialog').getByText('Your choice has been recorded.').waitFor();

  // A and the host get the toast in real time
  for (const [name, page] of [['A', a], ['host', host]] as const) {
    await page.getByText('New challenge', { exact: true }).waitFor();
    await page.getByText("Challenger's answer").waitFor();
    log(`${name} received the challenge notification live`);
  }
  await shot(a, '06-challenge-toast');
  await a.getByRole('button', { name: /Notifications, 2 unread/ }).waitFor();
  await a.getByRole('button', { name: 'View question' }).last().click();
  await a.getByText('Open challenge').waitFor();
  await a.getByText('Challenged answer · Riya').waitFor();
  await shot(a, '07-question-detail-challenged');
  log('A opened the challenged question from the notification');

  // click the image → full-screen viewer with zoom, pan and paging
  await a.getByRole('button', { name: 'Open image full screen to zoom' }).click();
  const viewer = a.getByRole('dialog', { name: /Image viewer/ });
  await viewer.getByText('1 of 2').waitFor();
  const zoomLevel = async () => parseInt((await viewer.getByRole('button', { name: 'Reset zoom' }).innerText()).replace('%', ''), 10);
  const transform = () => viewer.locator('img').evaluate((el) => (el as HTMLElement).style.transform);
  if ((await zoomLevel()) !== 100) throw new Error('viewer should open at 100%');
  await viewer.getByRole('button', { name: 'Zoom in' }).click();
  if ((await zoomLevel()) !== 150) throw new Error(`zoom button: expected 150%, got ${await zoomLevel()}%`);
  await a.mouse.move(210, 400);
  await a.mouse.wheel(0, -300);
  await a.waitForTimeout(200);
  const afterWheel = await zoomLevel();
  if (afterWheel <= 150) throw new Error(`wheel zoom did not zoom in (${afterWheel}%)`);
  const beforeDrag = await transform();
  await a.mouse.down();
  await a.mouse.move(150, 340, { steps: 4 });
  await a.mouse.up();
  if ((await transform()) === beforeDrag) throw new Error('dragging did not pan the zoomed image');
  await shot(a, '07b-image-viewer-zoomed');
  await viewer.getByRole('button', { name: 'Next image' }).click();
  await viewer.getByText('2 of 2').waitFor();
  if ((await zoomLevel()) !== 100) throw new Error('zoom should reset when changing image');
  await a.mouse.click(210, 400); // a click on the picture (even while it loads) must not close the viewer
  await viewer.getByText('2 of 2').waitFor();
  await viewer.locator('img').evaluate((el) => (el as HTMLImageElement).decode());
  await a.waitForTimeout(400);
  await a.mouse.dblclick(210, 400);
  if ((await zoomLevel()) !== 250) throw new Error(`double-click: expected 250%, got ${await zoomLevel()}%`);
  await a.keyboard.press('Minus');
  await a.keyboard.press('0');
  await a.mouse.click(210, 70); // beside the picture, not zoomed → closes
  await viewer.waitFor({ state: 'hidden' });
  await a.getByRole('button', { name: 'Open image full screen to zoom' }).click();
  await viewer.waitFor();
  await a.keyboard.press('Escape');
  await viewer.waitFor({ state: 'hidden' });
  await a.getByText('Open challenge').waitFor(); // still on the question underneath
  log(`image viewer: opens on click, zooms (buttons, wheel to ${afterWheel}%, double-click, keys), pans, pages, closes with Esc or a click beside the picture`);

  // host: questions list shows CHALLENGED, responds, then resolves
  while (await host.getByRole('button', { name: 'Dismiss' }).count()) await host.getByRole('button', { name: 'Dismiss' }).first().click();
  await host.getByRole('button', { name: 'Questions', exact: true }).click();
  await host.getByText('⚠️ Challenged').waitFor();
  await shot(host, '08-questions-challenged-host');
  await host.getByRole('heading', { name: 'Question #1' }).click();
  await host.getByRole('button', { name: 'Support original' }).click();
  await host.getByText('In discussion').waitFor();
  await a.getByText('In discussion').waitFor(); // A's open detail view updates live
  await a.getByText('2 participants support the original').waitFor();
  await a.getByText('Consensus 67%').waitFor();
  log('host supported the original; A\'s open question updated live (consensus 67%)');
  await host.getByText('Full history (host only)').waitFor();
  await shot(host, '09-host-question-detail');
  await host.getByRole('button', { name: 'Both considered valid' }).click();
  await host.getByText('Host decision:').waitFor();
  await a.getByText('Host decision:').waitFor();
  log('host resolved the challenge; A saw the decision live');

  await host.getByRole('button', { name: '← Back' }).click();
  await host.getByRole('button', { name: 'Host', exact: true }).click();
  await host.getByText('Question overview').waitFor();
  await shot(host, '10-host-dashboard');
  log('host dashboard renders');

  // host tools: live settings and the results export
  await host.getByRole('button', { name: 'Edit settings' }).click();
  await host.getByLabel('Private messages').uncheck();
  await host.getByRole('button', { name: 'Save settings' }).click();
  await host.getByText('Settings saved.').waitFor();
  await a.getByRole('button', { name: /^Chat/ }).click();
  await a.getByText('Private messages are turned off in this session.').waitFor(); // applied live, no reload
  await a.getByRole('button', { name: 'Close chat' }).click();
  const [download] = await Promise.all([host.waitForEvent('download'), host.getByRole('button', { name: 'Download results (CSV)' }).click()]);
  const csv = fs.readFileSync(await download.path(), 'utf8');
  if (!download.suggestedFilename().endsWith('-results.csv') || !csv.includes('Golden Retriever') || !csv.includes('Labrador'))
    throw new Error('the CSV export is missing answers');
  log('host changed a setting live (participants saw it at once) and downloaded the results CSV');

  // dark mode: toggles instantly, survives a reload
  await host.getByRole('button', { name: 'Switch to dark mode' }).click();
  if (!(await host.evaluate(() => document.documentElement.classList.contains('dark')))) throw new Error('dark mode did not switch on');
  await shot(host, '10b-host-dashboard-dark');
  await host.reload();
  await host.getByText('Question overview').waitFor();
  if (!(await host.evaluate(() => document.documentElement.classList.contains('dark')))) throw new Error('dark mode was not remembered');
  await host.getByRole('button', { name: 'Questions', exact: true }).click();
  await host.getByRole('heading', { name: 'Question #1' }).click();
  await host.getByText('Full history (host only)').waitFor();
  await shot(host, '10c-question-dark');
  await host.getByRole('button', { name: 'Switch to light mode' }).waitFor();
  log('dark mode switches on and is remembered');

  // filters / search on the questions tab
  await b.getByRole('button', { name: 'Done' }).click();
  await b.getByRole('button', { name: 'Questions', exact: true }).click();
  await b.getByRole('button', { name: 'Resolved', exact: true }).click();
  await b.getByRole('heading', { name: 'Question #1' }).waitFor();
  await b.getByRole('button', { name: 'Unanswered', exact: true }).click();
  await b.getByText('No questions match.').waitFor();
  await b.getByRole('button', { name: 'All', exact: true }).click();
  await b.getByLabel('Search questions').fill('labrador');
  await b.getByRole('heading', { name: 'Question #1' }).waitFor();
  await shot(b, '11-questions-filtered');
  log('filters and search work');

  // refresh keeps identity, tab and data
  await a.reload();
  await a.getByText('Challenged answer · Riya').waitFor();
  log('refreshing on an open question restores it');

  // demo mode: seeded session, identity links per window, sample photos
  const home = await open('demo-home', { width: 900, height: 900 });
  await home.goto(BASE);
  await home.getByRole('button', { name: 'Create demo session' }).click();
  await home.getByRole('button', { name: 'Open as Participant B' }).waitFor({ timeout: 60000 });
  const demo = await home.evaluate(() => JSON.parse(localStorage.getItem('vqa:demo')!));
  const tokenOf = (n: string) => demo.identities.find((i: any) => i.name === n).token;
  const demoB = await open('demo-B');
  await demoB.goto(`${BASE}/s/${demo.code}#token=${encodeURIComponent(tokenOf('Participant B'))}`);
  await demoB.getByRole('button', { name: 'Sample photos' }).click();
  if (demoB.url().includes('token=')) throw new Error('token was left in the address bar');
  await shot(demoB, '12-demo-samples');
  await demoB.getByRole('button', { name: /Dog \(another photo\)/ }).click();
  await demoB.getByLabel('Your answer').fill('Labrador');
  await demoB.getByRole('button', { name: 'Post answer' }).click();
  await demoB.getByRole('dialog').getByText('Golden Retriever', { exact: true }).waitFor({ timeout: 30000 });
  await demoB.getByRole('button', { name: 'Keep my answer without challenge' }).click();
  await demoB.getByRole('button', { name: 'Done' }).click();
  await demoB.getByRole('button', { name: 'Sample photos' }).click();
  await demoB.getByRole('button', { name: /Different dog/ }).click();
  await demoB.getByLabel('Your answer').fill('Labrador');
  await demoB.getByRole('button', { name: 'Post answer' }).click();
  await demoB.getByRole('dialog').getByText('We found a potentially related question.').waitFor({ timeout: 30000 });
  await shot(demoB, '13-possible-match');
  // images inside the "possible match" dialog are zoomable too; Esc closes only the viewer
  await demoB.getByRole('button', { name: 'Open Your image full screen' }).click();
  await demoB.getByRole('dialog', { name: /Image viewer/ }).getByText('1 of 2').waitFor();
  await demoB.keyboard.press('Escape');
  await demoB.getByRole('dialog', { name: /Image viewer/ }).waitFor({ state: 'hidden' });
  await demoB.getByText('We found a potentially related question.').waitFor();
  await demoB.getByRole('button', { name: 'No, create new question' }).click();
  await demoB.getByText(/Question #4 created\./).waitFor();
  const demoHost = await open('demo-host', { width: 900, height: 900 });
  await demoHost.goto(`${BASE}/s/${demo.code}?tab=host#token=${encodeURIComponent(tokenOf('Host'))}`);
  await demoHost.getByText('Question overview').waitFor();
  await demoHost.getByText('4 (2 online)').waitFor();
  log('demo session: identity links, sample photos, uncertain-match dialog and host view work');

  await browser.close();
  if (problems.length) throw new Error(`Browser problems:\n${problems.join('\n')}`);
  console.log(`\nUI walkthrough passed against ${BASE}. Screenshots: ${OUT}`);
}

main().then(() => process.exit(0), (err) => {
  console.error(`\n${err.message}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exit(1);
});
