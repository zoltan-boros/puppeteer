/**
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

let path = require('path');
let Browser = require('../lib/Browser');
let StaticServer = require('./StaticServer');
let GoldenUtils = require('./golden-utils');

let PORT = 8907;
let STATIC_PREFIX = 'http://localhost:' + PORT;
let EMPTY_PAGE = STATIC_PREFIX + '/empty.html';

jasmine.DEFAULT_TIMEOUT_INTERVAL = 10 * 1000;

describe('Puppeteer', function() {
  let browser;
  let staticServer;
  let page;

  beforeAll(function() {
    browser = new Browser({args: ['--no-sandbox']});
    staticServer = new StaticServer(path.join(__dirname, 'assets'), PORT);
    GoldenUtils.removeOutputDir();
  });

  afterAll(function() {
    browser.close();
    staticServer.stop();
  });

  beforeEach(SX(async function() {
    page = await browser.newPage();
    staticServer.reset();
    GoldenUtils.addMatchers(jasmine);
  }));

  afterEach(function() {
    page.close();
  });

  describe('Page.evaluate', function() {
    it('should work', SX(async function() {
      let result = await page.evaluate(() => 7 * 3);
      expect(result).toBe(21);
    }));
    it('should await promise', SX(async function() {
      let result = await page.evaluate(() => Promise.resolve(8 * 7));
      expect(result).toBe(56);
    }));
    it('should work from-inside inPageCallback', SX(async function() {
      // Setup inpage callback, which calls Page.evaluate
      await page.setInPageCallback('callController', async function(a, b) {
        return await page.evaluate((a, b) => a * b, a, b);
      });
      let result = await page.evaluate(async function() {
        return await callController(9, 3);
      });
      expect(result).toBe(27);
    }));
    it('should reject promise with exception', SX(async function() {
      let error = null;
      try {
        await page.evaluate(() => not.existing.object.property);
      } catch (e) {
        error = e;
      }
      expect(error).toBeTruthy();
      expect(error.message).toContain('not is not defined');
    }));
  });

  describe('Frame.evaluate', function() {
    let FrameUtils = require('./frame-utils');
    it('should have different execution contexts', SX(async function() {
      await page.navigate(EMPTY_PAGE);
      await FrameUtils.attachFrame(page, 'frame1', EMPTY_PAGE);
      expect(page.frames().length).toBe(2);
      let frame1 = page.frames()[0];
      let frame2 = page.frames()[1];
      await frame1.evaluate(() => window.FOO = 'foo');
      await frame2.evaluate(() => window.FOO = 'bar');
      expect(await frame1.evaluate(() => window.FOO)).toBe('foo');
      expect(await frame2.evaluate(() => window.FOO)).toBe('bar');
    }));
  });

  it('Page Events: ConsoleMessage', SX(async function() {
    let msgs = [];
    page.on('consolemessage', msg => msgs.push(msg));
    await page.evaluate(() => console.log('Message!'));
    expect(msgs).toEqual(['Message!']);
  }));

  describe('Page.navigate', function() {
    it('should fail when navigating to bad url', SX(async function() {
      let success = await page.navigate('asdfasdf');
      expect(success).toBe(false);
    }));
    it('should succeed when navigating to good url', SX(async function() {
      let success = await page.navigate(EMPTY_PAGE);
      expect(success).toBe(true);
    }));
    it('should wait for network idle to succeed navigation', SX(async function() {
      let responses = [];
      // Hold on a bunch of requests without answering.
      staticServer.setRoute('/fetch-request-a.js', (req, res) => responses.push(res));
      staticServer.setRoute('/fetch-request-b.js', (req, res) => responses.push(res));
      staticServer.setRoute('/fetch-request-c.js', (req, res) => responses.push(res));
      let fetchResourcesRequested = Promise.all([
        staticServer.waitForRequest('/fetch-request-a.js'),
        staticServer.waitForRequest('/fetch-request-b.js'),
        staticServer.waitForRequest('/fetch-request-c.js'),
      ]);
      // Navigate to a page which loads immediately and then does a bunch of
      // requests via javascript's fetch method.
      let navigationPromise = page.navigate(STATIC_PREFIX + '/networkidle.html', {
        minTime: 50 // Give page time to request more resources dynamically.
      });
      // Track when the navigation gets completed.
      let navigationFinished = false;
      navigationPromise.then(() => navigationFinished = true);

      // Wait for the page's 'load' event.
      await new Promise(fulfill => page.once('load', fulfill));
      expect(navigationFinished).toBe(false);

      // Wait for all three resources to be requested.
      await fetchResourcesRequested;

      // Expect navigation still to be not finished.
      expect(navigationFinished).toBe(false);

      // Respond to all requests.
      for (let response of responses) {
        response.statusCode = 404;
        response.end(`File not found`);
      }
      let success = await navigationPromise;
      // Expect navigation to succeed.
      expect(success).toBe(true);
    }));
  });

  describe('Page.setInPageCallback', function() {
    it('should work', SX(async function() {
      await page.setInPageCallback('callController', function(a, b) {
        return a * b;
      });
      let result = await page.evaluate(async function() {
        return await callController(9, 4);
      });
      expect(result).toBe(36);
    }));
    it('should survive navigation', SX(async function() {
      await page.setInPageCallback('callController', function(a, b) {
        return a * b;
      });

      await page.navigate(EMPTY_PAGE);
      let result = await page.evaluate(async function() {
        return await callController(9, 4);
      });
      expect(result).toBe(36);
    }));
    it('should await returned promise', SX(async function() {
      await page.setInPageCallback('callController', function(a, b) {
        return Promise.resolve(a * b);
      });

      let result = await page.evaluate(async function() {
        return await callController(3, 5);
      });
      expect(result).toBe(15);
    }));
  });

  describe('Page.setRequestInterceptor', function() {
    it('should intercept', SX(async function() {
      page.setRequestInterceptor(request => {
        expect(request.url()).toContain('empty.html');
        expect(request.headers()['User-Agent']).toBeTruthy();
        expect(request.method()).toBe('GET');
        expect(request.postData()).toBe(undefined);
        request.continue();
      });
      let success = await page.navigate(EMPTY_PAGE);
      expect(success).toBe(true);
    }));
    it('should show extraHTTPHeaders', SX(async function() {
      await page.setExtraHTTPHeaders({
        foo: 'bar'
      });
      page.setRequestInterceptor(request => {
        expect(request.headers()['foo']).toBe('bar');
        request.continue();
      });
      let success = await page.navigate(EMPTY_PAGE);
      expect(success).toBe(true);
    }));
    it('should be abortable', SX(async function() {
      page.setRequestInterceptor(request => {
        if (request.url().endsWith('.css'))
          request.abort();
        else
          request.continue();
      });
      let failedResources = 0;
      page.on('resourceloadingfailed', event => ++failedResources);
      let success = await page.navigate(STATIC_PREFIX + '/one-style.html');
      expect(success).toBe(true);
      expect(failedResources).toBe(1);
    }));
  });

  describe('Page.Events.Dialog', function() {
    it('should fire', function(done) {
      page.on('dialog', dialog => {
        expect(dialog.type).toBe('alert');
        expect(dialog.message()).toBe('yo');
        done();
      });
      page.evaluate(() => alert('yo'));
    });
    // TODO Enable this when crbug.com/718235 is fixed.
    xit('should allow accepting prompts', SX(async function(done) {
      page.on('dialog', dialog => {
        expect(dialog.type).toBe('prompt');
        expect(dialog.message()).toBe('question?');
        dialog.accept('answer!');
      });
      let result = await page.evaluate(() => prompt('question?'));
      expect(result).toBe('answer!');
    }));
  });

  describe('Page.Events.Error', function() {
    it('should fire', function(done) {
      page.on('error', error => {
        expect(error.message).toContain('Fancy');
        done();
      });
      page.navigate(STATIC_PREFIX + '/error.html');
    });
  });

  describe('Page.screenshot', function() {
    it('should work', SX(async function() {
      await page.setViewportSize({width: 500, height: 500});
      await page.navigate(STATIC_PREFIX + '/grid.html');
      let screenshot = await page.screenshot();
      expect(screenshot).toBeGolden('screenshot-sanity.png');
    }));
    it('should clip rect', SX(async function() {
      await page.setViewportSize({width: 500, height: 500});
      await page.navigate(STATIC_PREFIX + '/grid.html');
      let screenshot = await page.screenshot({
        clip: {
          x: 50,
          y: 100,
          width: 150,
          height: 100
        }
      });
      expect(screenshot).toBeGolden('screenshot-clip-rect.png');
    }));
    it('should work for offscreen clip', SX(async function() {
      await page.setViewportSize({width: 500, height: 500});
      await page.navigate(STATIC_PREFIX + '/grid.html');
      let screenshot = await page.screenshot({
        clip: {
          x: 50,
          y: 600,
          width: 100,
          height: 100
        }
      });
      expect(screenshot).toBeGolden('screenshot-offscreen-clip.png');
    }));
    it('should run in parallel', SX(async function() {
      await page.setViewportSize({width: 500, height: 500});
      await page.navigate(STATIC_PREFIX + '/grid.html');
      let promises = [];
      for (let i = 0; i < 3; ++i) {
        promises.push(page.screenshot({
          clip: {
            x: 50 * i,
            y: 0,
            width: 50,
            height: 50
          }
        }));
      }
      let screenshot = await promises[1];
      expect(screenshot).toBeGolden('screenshot-parallel-calls.png');
    }));
    it('should take fullPage screenshots', SX(async function() {
      await page.setViewportSize({width: 500, height: 500});
      await page.navigate(STATIC_PREFIX + '/grid.html');
      let screenshot = await page.screenshot({
        fullPage: true
      });
      expect(screenshot).toBeGolden('screenshot-grid-fullpage.png');
    }));
  });

  describe('Frame Management', function() {
    let FrameUtils = require('./frame-utils');
    it('should handle nested frames', SX(async function() {
      await page.navigate(STATIC_PREFIX + '/frames/nested-frames.html');
      expect(FrameUtils.dumpFrames(page.mainFrame())).toBeGolden('nested-frames.txt');
    }));
    it('should send events when frames are manipulated dynamically', SX(async function() {
      await page.navigate(EMPTY_PAGE);
      // validate frameattached events
      let attachedFrames = [];
      page.on('frameattached', frame => attachedFrames.push(frame));
      await FrameUtils.attachFrame(page, 'frame1', './assets/frame.html');
      expect(attachedFrames.length).toBe(1);
      expect(attachedFrames[0].url()).toContain('/assets/frame.html');

      // validate framenavigated events
      let navigatedFrames = [];
      page.on('framenavigated', frame => navigatedFrames.push(frame));
      await FrameUtils.navigateFrame(page, 'frame1', './empty.html');
      expect(navigatedFrames.length).toBe(1);
      expect(navigatedFrames[0].url()).toContain('/empty.html');

      // validate framedetached events
      let detachedFrames = [];
      page.on('framedetached', frame => detachedFrames.push(frame));
      await FrameUtils.detachFrame(page, 'frame1');
      expect(detachedFrames.length).toBe(1);
      expect(detachedFrames[0].isDetached()).toBe(true);
    }));
    it('should persist mainFrame on cross-process navigation', SX(async function() {
      await page.navigate(EMPTY_PAGE);
      let mainFrame = page.mainFrame();
      await page.navigate('http://127.0.0.1:' + PORT + '/empty.html');
      expect(page.mainFrame() === mainFrame).toBeTruthy();
    }));
    it('should not send attach/detach events for main frame', SX(async function() {
      let hasEvents = false;
      page.on('frameattached', frame => hasEvents = true);
      page.on('framedetached', frame => hasEvents = true);
      await page.navigate(EMPTY_PAGE);
      expect(hasEvents).toBe(false);
    }));
    it('should detach child frames on navigation', SX(async function() {
      let attachedFrames = [];
      let detachedFrames = [];
      let navigatedFrames = [];
      page.on('frameattached', frame => attachedFrames.push(frame));
      page.on('framedetached', frame => detachedFrames.push(frame));
      page.on('framenavigated', frame => navigatedFrames.push(frame));
      await page.navigate(STATIC_PREFIX + '/frames/nested-frames.html');
      expect(attachedFrames.length).toBe(4);
      expect(detachedFrames.length).toBe(0);
      expect(navigatedFrames.length).toBe(5);

      attachedFrames = [];
      detachedFrames = [];
      navigatedFrames = [];
      await page.navigate(EMPTY_PAGE);
      expect(attachedFrames.length).toBe(0);
      expect(detachedFrames.length).toBe(4);
      expect(navigatedFrames.length).toBe(1);
    }));
  });

  describe('input', function() {
    it('should click the button', SX(async function() {
      await page.navigate(STATIC_PREFIX + '/input/button.html');
      await page.click('button');
      expect(await page.evaluate(() => result)).toBe('Clicked');
    }));
    it('should type into the textarea', SX(async function() {
      await page.navigate(STATIC_PREFIX + '/input/textarea.html');
      await page.focus('textarea');
      await page.type('Type in this text!');
      expect(await page.evaluate(() => result)).toBe('Type in this text!');
    }));
    it('should click the button after navigation ', SX(async function() {
      await page.navigate(STATIC_PREFIX + '/input/button.html');
      await page.click('button');
      await page.navigate(STATIC_PREFIX + '/input/button.html');
      await page.click('button');
      expect(await page.evaluate(() => result)).toBe('Clicked');
    }));
  });
});

// Since Jasmine doesn't like async functions, they should be wrapped
// in a SX function.
function SX(fun) {
  return done => Promise.resolve(fun()).then(done).catch(done.fail);
}
