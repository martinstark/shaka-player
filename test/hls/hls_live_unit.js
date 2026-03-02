/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

describe('HlsParser live', () => {
  const ManifestParser = shaka.test.ManifestParser;

  const master = [
    '#EXTM3U\n',
    '#EXT-X-STREAM-INF:BANDWIDTH=200,CODECS="avc1",',
    'RESOLUTION=960x540,FRAME-RATE=60\n',
    'video\n',
  ].join('');

  /** @type {!shaka.test.FakeNetworkingEngine} */
  let fakeNetEngine;
  /** @type {!shaka.hls.HlsParser} */
  let parser;
  /** @type {shaka.extern.ManifestParser.PlayerInterface} */
  let playerInterface;
  /** @type {shaka.extern.ManifestConfiguration} */
  let config;
  /** @type {!Uint8Array} */
  let initSegmentData;
  /** @type {!Uint8Array} */
  let segmentData;
  /** @type {!Uint8Array} */
  let selfInitializingSegmentData;

  beforeEach(() => {
    // TODO: use StreamGenerator?
    initSegmentData = new Uint8Array([
      0x00, 0x00, 0x00, 0x36, // size (54)
      0x6D, 0x6F, 0x6F, 0x76, // type (moov)
      0x00, 0x00, 0x00, 0x2E, // trak size (46)
      0x74, 0x72, 0x61, 0x6B, // type (trak)
      0x00, 0x00, 0x00, 0x26, // mdia size (38)
      0x6D, 0x64, 0x69, 0x61, // type (mdia)

      0x00, 0x00, 0x00, 0x1E, // mdhd size (30)
      0x6D, 0x64, 0x68, 0x64, // type (mdhd)
      0x00, 0x00, 0x00, 0x00, // version and flags

      0x00, 0x00, 0x00, 0x00, // creation time (0)
      0x00, 0x00, 0x00, 0x00, // modification time (0)
      0x00, 0x00, 0x03, 0xe8, // timescale (1000)
      0x00, 0x00, 0x00, 0x00, // duration (0)
      0x55, 0xC4, // language (und)
    ]);
    segmentData = new Uint8Array([
      0x00, 0x00, 0x00, 0x24, // size (36)
      0x6D, 0x6F, 0x6F, 0x66, // type (moof)
      0x00, 0x00, 0x00, 0x1C, // traf size (28)
      0x74, 0x72, 0x61, 0x66, // type (traf)
      0x00, 0x00, 0x00, 0x14, // tfdt size (20)
      0x74, 0x66, 0x64, 0x74, // type (tfdt)
      0x01, 0x00, 0x00, 0x00, // version and flags
      0x00, 0x00, 0x00, 0x00, // baseMediaDecodeTime first 4 bytes
      0x00, 0x00, 0x07, 0xd0, // baseMediaDecodeTime last 4 bytes (2000)
    ]);

    selfInitializingSegmentData =
        shaka.util.Uint8ArrayUtils.concat(initSegmentData, segmentData);

    fakeNetEngine = new shaka.test.FakeNetworkingEngine();

    config = shaka.util.PlayerConfiguration.createDefault().manifest;
    playerInterface = {
      filter: () => Promise.resolve(),
      makeTextStreamsForClosedCaptions: (manifest) => {},
      networkingEngine: fakeNetEngine,
      onError: fail,
      onEvent: fail,
      onTimelineRegionAdded: fail,
      isLowLatencyMode: () => false,
      updateDuration: () => {},
      newDrmInfo: (stream) => {},
      onManifestUpdated: () => {},
      getBandwidthEstimate: () => 1e6,
      onMetadata: () => {},
      disableStream: (stream) => {},
      addFont: (name, url) => {},
    };

    parser = new shaka.hls.HlsParser();
    parser.configure(config);
  });

  afterEach(() => {
    // HLS parser stop is synchronous.
    parser.stop();
  });

  /**
   * Gets a spy on the function that sets the update period.
   * @return {!jasmine.Spy}
   * @suppress {accessControls}
   */
  function updateTickSpy() {
    return spyOn(parser.updatePlaylistTimer_, 'tickAfter');
  }

  /**
   * Trigger a manifest update.
   * @suppress {accessControls}
   */
  async function delayForUpdatePeriod() {
    parser.updatePlaylistTimer_.tickNow();
    await shaka.test.Util.shortDelay();  // Allow update to finish.
  }

  /**
   * @param {string} master
   * @param {string} media1
   * @param {string} media2
   */
  function configureNetEngineForInitialManifest(master, media1, media2) {
    fakeNetEngine
        .setResponseText('test:/master', master)
        .setResponseText('test:/video', media1)
        .setResponseText('test:/redirected/video', media1)
        .setResponseText('test:/video2', media2)
        .setResponseText('test:/audio', media1)
        .setResponseValue('test:/init.mp4', initSegmentData)
        .setResponseValue('test:/main.mp4', segmentData)
        .setResponseValue('test:/main0.mp4', segmentData)
        .setResponseValue('test:/main2.mp4', segmentData)
        .setResponseValue('test:/main3.mp4', segmentData)
        .setResponseValue('test:/main4.mp4', segmentData)
        .setResponseValue('test:/partial.mp4', segmentData)
        .setResponseValue('test:/partial2.mp4', segmentData)
        .setResponseValue('test:/ref1.mp4', segmentData)
        .setResponseValue('test:/selfInit.mp4', selfInitializingSegmentData);
  }

  /**
   * @param {string} master
   * @param {string} initialMedia
   * @param {Array=} initialReferences
   * @return {!Promise<shaka.extern.Manifest>}
   */
  async function testInitialManifest(
      master, initialMedia, initialReferences=null) {
    configureNetEngineForInitialManifest(master, initialMedia, initialMedia);

    const manifest = await parser.start('test:/master', playerInterface);

    // Create the segment index for the variants, to finish the lazy-loading.
    await Promise.all(manifest.variants.map(async (variant) => {
      await variant.video.createSegmentIndex();

      if (initialReferences) {
        ManifestParser.verifySegmentIndex(variant.video, initialReferences);
      }

      if (variant.audio) {
        await variant.audio.createSegmentIndex();
        if (initialReferences) {
          ManifestParser.verifySegmentIndex(variant.audio, initialReferences);
        }
      }
    }));

    return manifest;
  }

  /**
   * @param {shaka.extern.Manifest} manifest
   * @param {string} updatedMedia
   * @param {Array=} updatedReferences
   */
  async function testUpdate(manifest, updatedMedia, updatedReferences=null) {
    // Replace the entries with the updated values.
    fakeNetEngine
        .setResponseText('test:/video', updatedMedia)
        .setResponseText('test:/redirected/video', updatedMedia)
        .setResponseText('test:/video2', updatedMedia)
        .setResponseText('test:/audio', updatedMedia);

    await delayForUpdatePeriod();

    if (updatedReferences) {
      for (const variant of manifest.variants) {
        ManifestParser.verifySegmentIndex(variant.video, updatedReferences);
        if (variant.audio) {
          ManifestParser.verifySegmentIndex(variant.audio, updatedReferences);
        }
      }
    }
  }

  describe('playlist type EVENT', () => {
    const media = [
      '#EXTM3U\n',
      '#EXT-X-PLAYLIST-TYPE:EVENT\n',
      '#EXT-X-TARGETDURATION:5\n',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
      '#EXTINF:2,\n',
      'main.mp4\n',
    ].join('');

    const mediaWithAdditionalSegment = [
      '#EXTM3U\n',
      '#EXT-X-PLAYLIST-TYPE:EVENT\n',
      '#EXT-X-TARGETDURATION:5\n',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
      '#EXTINF:2,\n',
      'main.mp4\n',
      '#EXTINF:2,\n',
      'main2.mp4\n',
    ].join('');

    it('treats already ended presentation like VOD', async () => {
      const manifest = await testInitialManifest(
          master, media + '#EXT-X-ENDLIST');
      expect(manifest.presentationTimeline.isLive()).toBe(false);
      expect(manifest.presentationTimeline.isInProgress()).toBe(false);
    });

    describe('update', () => {
      it('adds new segments when they appear', async () => {
        const ref1 = makeReference(
            'test:/main.mp4', 0, 2, /* syncTime= */ null);
        const ref2 = makeReference(
            'test:/main2.mp4', 2, 4, /* syncTime= */ null);

        const manifest = await testInitialManifest(master, media, [ref1]);
        await testUpdate(manifest, mediaWithAdditionalSegment, [ref1, ref2]);
      });

      it('updates all variants', async () => {
        const secondVariant = [
          '#EXT-X-STREAM-INF:BANDWIDTH=300,CODECS="avc1",',
          'RESOLUTION=1200x940,FRAME-RATE=60\n',
          'video2',
        ].join('');

        const masterWithTwoVariants = master + secondVariant;
        const ref1 = makeReference(
            'test:/main.mp4', 0, 2, /* syncTime= */ null);
        const ref2 = makeReference(
            'test:/main2.mp4', 2, 4, /* syncTime= */ null);

        const manifest = await testInitialManifest(
            masterWithTwoVariants, media, [ref1]);
        await testUpdate(manifest, mediaWithAdditionalSegment, [ref1, ref2]);
      });

      it('updates all streams', async () => {
        const masterlist = [
          '#EXTM3U\n',
          '#EXT-X-STREAM-INF:BANDWIDTH=200,CODECS="avc1",AUDIO="aud1",',
          'RESOLUTION=960x540,FRAME-RATE=60\n',
          'video\n',
        ].join('');
        const audio = [
          '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",LANGUAGE="eng",',
          'URI="audio"\n',
        ].join('');

        const masterWithAudio = masterlist + audio;
        const ref1 = makeReference(
            'test:/main.mp4', 0, 2, /* syncTime= */ null);
        const ref2 = makeReference(
            'test:/main2.mp4', 2, 4, /* syncTime= */ null);

        const manifest = await testInitialManifest(
            masterWithAudio, media, [ref1]);
        await testUpdate(manifest, mediaWithAdditionalSegment, [ref1, ref2]);
      });

      it('handles multiple updates', async () => {
        const newSegment1 = [
          '#EXTINF:2,\n',
          'main2.mp4\n',
        ].join('');

        const newSegment2 = [
          '#EXTINF:2,\n',
          'main3.mp4\n',
        ].join('');

        const updatedMedia1 = media + newSegment1;
        const updatedMedia2 = updatedMedia1 + newSegment2;
        const ref1 = makeReference(
            'test:/main.mp4', 0, 2, /* syncTime= */ null);
        const ref2 = makeReference(
            'test:/main2.mp4', 2, 4, /* syncTime= */ null);
        const ref3 = makeReference(
            'test:/main3.mp4', 4, 6, /* syncTime= */ null);

        const manifest = await testInitialManifest(master, media, [ref1]);
        await testUpdate(manifest, updatedMedia1, [ref1, ref2]);
        await testUpdate(manifest, updatedMedia2, [ref1, ref2, ref3]);
      });

      it('converts presentation to VOD when it is finished', async () => {
        const manifest = await testInitialManifest(master, media);
        expect(manifest.presentationTimeline.isLive()).toBe(false);
        expect(manifest.presentationTimeline.isInProgress()).toBe(true);

        await testUpdate(
            manifest, mediaWithAdditionalSegment + '#EXT-X-ENDLIST\n');
        expect(manifest.presentationTimeline.isInProgress()).toBe(false);
      });

      it('starts presentation as VOD when ENDLIST is present', async () => {
        const manifest = await testInitialManifest(
            master, media + '#EXT-X-ENDLIST');
        expect(manifest.presentationTimeline.isLive()).toBe(false);
        expect(manifest.presentationTimeline.isInProgress()).toBe(false);
      });

      it('does not throw when interrupted by stop', async () => {
        const manifest = await testInitialManifest(master, media);
        expect(manifest.presentationTimeline.isLive()).toBe(false);
        expect(manifest.presentationTimeline.isInProgress()).toBe(true);

        // Block the next request so that update() is still happening when we
        // call stop().
        /** @type {!shaka.util.PublicPromise} */
        const delay = fakeNetEngine.delayNextRequest();
        // Trigger an update.
        await delayForUpdatePeriod();
        // Stop the parser mid-update, but don't wait for stop to complete.
        const stopPromise = parser.stop();
        // Unblock the request.
        delay.resolve();
        // Allow update to finish.
        await shaka.test.Util.shortDelay();
        // Wait for stop to complete.
        await stopPromise;
      });

      it('calls notifySegments on each update', async () => {
        const manifest = await testInitialManifest(master, media);
        const notifySegmentsSpy = spyOn(
            manifest.presentationTimeline, 'notifySegments').and.callThrough();

        // Trigger an update.
        await delayForUpdatePeriod();

        expect(notifySegmentsSpy).toHaveBeenCalled();
        notifySegmentsSpy.calls.reset();

        // Trigger another update.
        await delayForUpdatePeriod();

        expect(notifySegmentsSpy).toHaveBeenCalled();
      });

      it('fatal error on manifest update request failure when ' +
          'raiseFatalErrorOnManifestUpdateRequestFailure is true', async () => {
        const manifestConfig =
        shaka.util.PlayerConfiguration.createDefault().manifest;
        manifestConfig.raiseFatalErrorOnManifestUpdateRequestFailure = true;
        parser.configure(manifestConfig);

        const updateTick = updateTickSpy();

        await testInitialManifest(master, media);
        expect(updateTick).toHaveBeenCalledTimes(1);

        /** @type {!jasmine.Spy} */
        const onError = jasmine.createSpy('onError');
        playerInterface.onError = shaka.test.Util.spyFunc(onError);

        const error = new shaka.util.Error(
            shaka.util.Error.Severity.CRITICAL,
            shaka.util.Error.Category.NETWORK,
            shaka.util.Error.Code.BAD_HTTP_STATUS);
        const operation = shaka.util.AbortableOperation.failed(error);
        fakeNetEngine.request.and.returnValue(operation);

        await delayForUpdatePeriod();
        expect(onError).toHaveBeenCalledWith(error);
        expect(updateTick).toHaveBeenCalledTimes(1);
      });

      it('converts to VOD only after all playlists end', async () => {
        const master = [
          '#EXTM3U\n',
          '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",LANGUAGE="eng",',
          'URI="audio"\n',
          '#EXT-X-STREAM-INF:BANDWIDTH=200,CODECS="avc1",AUDIO="aud1",',
          'RESOLUTION=960x540,FRAME-RATE=60\n',
          'video\n',
        ].join('');

        const mediaWithEndList = media + '#EXT-X-ENDLIST';

        const manifest = await testInitialManifest(master, media);
        expect(manifest.presentationTimeline.isLive()).toBe(false);
        expect(manifest.presentationTimeline.isInProgress()).toBe(true);

        // Update video only.
        fakeNetEngine.setResponseText('test:/video', mediaWithEndList);
        await delayForUpdatePeriod();

        // Audio hasn't "ended" yet, so we're still in progress.
        expect(manifest.presentationTimeline.isInProgress()).toBe(true);

        // Update audio.
        fakeNetEngine.setResponseText('test:/audio', mediaWithEndList);
        await delayForUpdatePeriod();

        // Now both have "ended", so we're no longer in progress.
        expect(manifest.presentationTimeline.isInProgress()).toBe(false);
      });

      it('stops updating after all playlists end', async () => {
        const manifest = await testInitialManifest(master, media);
        expect(manifest.presentationTimeline.isLive()).toBe(false);
        expect(manifest.presentationTimeline.isInProgress()).toBe(true);

        fakeNetEngine.request.calls.reset();
        await testUpdate(
            manifest, mediaWithAdditionalSegment + '#EXT-X-ENDLIST\n');

        // We saw one request for the video playlist, which signalled "ENDLIST".
        const type =
            shaka.net.NetworkingEngine.AdvancedRequestType.MEDIA_PLAYLIST;

        fakeNetEngine.expectRequest(
            'test:/video',
            shaka.net.NetworkingEngine.RequestType.MANIFEST,
            {type});
        expect(manifest.presentationTimeline.isInProgress()).toBe(false);

        fakeNetEngine.request.calls.reset();
        await delayForUpdatePeriod();

        // No new updates were requested.
        expect(fakeNetEngine.request).not.toHaveBeenCalled();
      });

      it('convert variant to encrypted on update', async () => {
        const manifest = await testInitialManifest(master, media);
        expect(manifest.variants[0].video.encrypted).toBe(false);

        const initDataBase64 =
            'dGhpcyBpbml0IGRhdGEgY29udGFpbnMgaGlkZGVuIHNlY3JldHMhISE=';

        const keyId = 'abc123';

        const mediaWithAdditionalInfo = [
          '#EXTM3U\n',
          '#EXT-X-PLAYLIST-TYPE:EVENT\n',
          '#EXT-X-TARGETDURATION:5\n',
          '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
          '#EXTINF:2,\n',
          'main.mp4\n',
          '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,',
          'KEYID=0X' + keyId + ',',
          'KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",',
          'URI="data:text/plain;base64,',
          initDataBase64, '",\n',
          '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
          '#EXTINF:2,\n',
          'main2.mp4\n',
        ].join('');

        await testUpdate(manifest, mediaWithAdditionalInfo);
        expect(manifest.variants[0].video.encrypted).toBe(true);
      });
    });  // describe('update')
  });  // describe('playlist type EVENT')

  describe('playlist type LIVE', () => {
    const media = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:5\n',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
      '#EXT-X-MEDIA-SEQUENCE:0\n',
      '#EXTINF:2,\n',
      'main.mp4\n',
    ].join('');

    const mediaWithoutSequenceNumber = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:5\n',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
      '#EXTINF:2,\n',
      'main.mp4\n',
    ].join('');

    const mediaWithAdditionalSegment = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:5\n',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
      '#EXT-X-MEDIA-SEQUENCE:0\n',
      '#EXTINF:2,\n',
      'main.mp4\n',
      '#EXTINF:2,\n',
      'main2.mp4\n',
    ].join('');

    const mediaWithRemovedSegment = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:5\n',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
      '#EXT-X-MEDIA-SEQUENCE:1\n',
      '#EXTINF:2,\n',
      'main2.mp4\n',
    ].join('');

    const mediaWithAdditionalSegment2 = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:5\n',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
      '#EXT-X-MEDIA-SEQUENCE:0\n',
      '#EXTINF:2,\n',
      'main3.mp4\n',
      '#EXTINF:2,\n',
      'main4.mp4\n',
    ].join('');

    const mediaWithRemovedSegment2 = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:5\n',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
      '#EXT-X-MEDIA-SEQUENCE:1\n',
      '#EXTINF:2,\n',
      'main4.mp4\n',
    ].join('');

    let mediaWithManySegments = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:5\n',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
      '#EXT-X-MEDIA-SEQUENCE:0\n',
    ].join('');

    for (let i = 0; i < 1000; i++) {
      mediaWithManySegments += '#EXTINF:2,\n';
      mediaWithManySegments += 'main.mp4\n';
    }

    const mediaWithDiscontinuity = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:5\n',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
      '#EXT-X-MEDIA-SEQUENCE:0\n',
      '#EXT-X-DISCONTINUITY-SEQUENCE:30\n',
      '#EXTINF:2,\n',
      'main.mp4\n',
      '#EXT-X-DISCONTINUITY\n',
      '#EXTINF:2,\n',
      'main2.mp4\n',
    ].join('');

    const mediaWithUpdatedDiscontinuitySegment = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:5\n',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
      '#EXT-X-MEDIA-SEQUENCE:1\n',
      '#EXT-X-DISCONTINUITY-SEQUENCE:31\n',
      '#EXTINF:2,\n',
      'main2.mp4\n',
    ].join('');

    it('starts presentation as VOD when ENDLIST is present', async () => {
      const manifest = await testInitialManifest(
          master, media + '#EXT-X-ENDLIST');
      expect(manifest.presentationTimeline.isLive()).toBe(false);
    });

    it('does not fail on a missing sequence number', async () => {
      await testInitialManifest(master, mediaWithoutSequenceNumber);
    });

    it('sets presentation delay as configured', async () => {
      config.defaultPresentationDelay = 10;
      parser.configure(config);

      const manifest = await testInitialManifest(master, media);
      expect(manifest.presentationTimeline.getDelay()).toBe(
          config.defaultPresentationDelay);
    });

    it('sets 3 times target duration as presentation delay if not configured',
        async () => {
          const media = [
            '#EXTM3U\n',
            '#EXT-X-TARGETDURATION:2\n',
            '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
            '#EXT-X-MEDIA-SEQUENCE:0\n',
            '#EXTINF:2,\n',
            'main.mp4\n',
            '#EXTINF:2,\n',
            'main.mp4\n',
            '#EXTINF:2,\n',
            'main.mp4\n',
            '#EXTINF:2,\n',
            'main.mp4\n',
            '#EXTINF:2,\n',
            'main.mp4\n',
            '#EXTINF:2,\n',
            'main.mp4\n',
          ].join('');
          const manifest = await testInitialManifest(master, media);
          expect(manifest.presentationTimeline.getDelay()).toBe(6);
        });

    it('sets 3 times target duration as presentation delay if not configured and clamped to the start', async () => { // eslint-disable-line @stylistic/max-len
      const media = [
        '#EXTM3U\n',
        '#EXT-X-TARGETDURATION:2\n',
        '#EXT-X-START:TIME-OFFSET=-4\n',
        '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
        '#EXT-X-MEDIA-SEQUENCE:0\n',
        '#EXTINF:2,\n',
        'main.mp4\n',
        '#EXTINF:2,\n',
        'main.mp4\n',
        '#EXTINF:2,\n',
        'main.mp4\n',
        '#EXTINF:2,\n',
        'main.mp4\n',
        '#EXTINF:2,\n',
        'main.mp4\n',
        '#EXTINF:2,\n',
        'main.mp4\n',
      ].join('');
      const manifest = await testInitialManifest(master, media);
      expect(manifest.presentationTimeline.getDelay()).toBe(4);
      expect(manifest.startTime).toBe(0);
    });

    it('sets 2 times target duration as presentation delay if there are not enough segments', async () => { // eslint-disable-line @stylistic/max-len
      const media = [
        '#EXTM3U\n',
        '#EXT-X-TARGETDURATION:2\n',
        '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
        '#EXT-X-MEDIA-SEQUENCE:0\n',
        '#EXTINF:2,\n',
        'main.mp4\n',
        '#EXTINF:2,\n',
        'main.mp4\n',
      ].join('');
      const manifest = await testInitialManifest(master, media);
      expect(manifest.presentationTimeline.getDelay()).toBe(4);
    });

    it('sets presentation delay if defined', async () => {
      const media = [
        '#EXTM3U\n',
        '#EXT-X-SERVER-CONTROL:HOLD-BACK=2\n',
        '#EXT-X-TARGETDURATION:5\n',
        '#EXT-X-PART-INF:PART-TARGET=0.5\n',
        '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
        '#EXT-X-MEDIA-SEQUENCE:0\n',
        '#EXTINF:2,\n',
        'main.mp4\n',
      ].join('');

      const manifest = await testInitialManifest(master, media);
      // Presentation delay should be the value of 'HOLD-BACK' if not
      // configured.
      expect(manifest.presentationTimeline.getDelay()).toBe(2);
    });

    it('sets presentation delay for low latency mode', async () => {
      const mediaWithLowLatency = [
        '#EXTM3U\n',
        '#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1.8\n',
        '#EXT-X-TARGETDURATION:5\n',
        '#EXT-X-PART-INF:PART-TARGET=0.5\n',
        '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
        '#EXT-X-MEDIA-SEQUENCE:0\n',
        '#EXTINF:2,\n',
        'main.mp4\n',
      ].join('');

      playerInterface.isLowLatencyMode = () => true;

      const manifest = await testInitialManifest(master, mediaWithLowLatency);
      // Presentation delay should be the value of 'PART-HOLD-BACK' if not
      // configured.
      expect(manifest.presentationTimeline.getDelay()).toBe(1.8);
    });

    describe('availabilityWindowOverride', () => {
      async function testWindowOverride(expectedWindow) {
        const manifest = await testInitialManifest(
            master, mediaWithManySegments);
        expect(manifest).toBeTruthy();
        const timeline = manifest.presentationTimeline;
        expect(timeline).toBeTruthy();

        const start = timeline.getSegmentAvailabilityStart();
        const end = timeline.getSegmentAvailabilityEnd();
        expect(end - start).toBeCloseTo(expectedWindow, 1);
      }

      it('does not affect seek range if unset', async () => {
        await testWindowOverride(2000);
      });

      it('overrides default seek range if set', async () => {
        config.availabilityWindowOverride = 240;
        parser.configure(config);
        await testWindowOverride(240);
      });
    });

    it('sets discontinuity sequence numbers', async () => {
      const ref1 = makeReference(
          'test:/main.mp4', 0, 2, /* syncTime= */ null,
          /* baseUri= */ '', /* startByte= */ 0, /* endByte= */ null,
          /* timestampOffset= */ 0);
      ref1.discontinuitySequence = 30;

      const ref2 = makeReference(
          'test:/main2.mp4', 2, 4, /* syncTime= */ null,
          /* baseUri= */ '', /* startByte= */ 0, /* endByte= */ null,
          /* timestampOffset= */ 0);
      ref2.discontinuitySequence = 31;

      const manifest = await testInitialManifest(
          master, mediaWithDiscontinuity, [ref1, ref2]);

      await testUpdate(
          manifest, mediaWithUpdatedDiscontinuitySegment, [ref2]);
    });

    // Test for https://github.com/shaka-project/shaka-player/issues/4223
    it('parses streams with partial and preload hinted segments', async () => {
      playerInterface.isLowLatencyMode = () => true;
      const mediaWithPartialSegments = [
        '#EXTM3U\n',
        '#EXT-X-TARGETDURATION:5\n',
        '#EXT-X-PART-INF:PART-TARGET=1.5\n',
        '#EXT-X-MAP:URI="init.mp4"\n',
        '#EXT-X-MEDIA-SEQUENCE:0\n',
        // ref includes partialRef, partialRef2
        // partialRef
        '#EXT-X-PART:DURATION=2,URI="partial.mp4",INDEPENDENT=YES\n',
        // partialRef2
        '#EXT-X-PART:DURATION=2,URI="partial2.mp4",INDEPENDENT=YES\n',
        '#EXTINF:4,\n',
        'main.mp4\n',
        // ref2 includes partialRef3, preloadRef
        // partialRef3
        '#EXT-X-PART:DURATION=2,URI="partial.mp4",INDEPENDENT=YES\n',
        // preloadRef
        '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="partial.mp4"\n',
      ].join('');

      const partialRef = makeReference(
          'test:/partial.mp4', 0, 2, /* syncTime= */ null,
          /* baseUri= */ '', /* startByte= */ 0, /* endByte= */ null);
      partialRef.partial = true;

      const partialRef2 = makeReference(
          'test:/partial2.mp4', 2, 4, /* syncTime= */ null,
          /* baseUri= */ '', /* startByte= */ 0, /* endByte= */ null);
      partialRef2.partial = true;
      partialRef2.lastPartial = true;

      const ref = makeReference(
          'test:/main.mp4', 0, 4, /* syncTime= */ null,
          /* baseUri= */ '', /* startByte= */ 0, /* endByte= */ null,
          /* timestampOffset= */ 0, [partialRef, partialRef2]);
      ref.allPartialSegments = true;

      const partialRef3 = makeReference(
          'test:/partial.mp4', 4, 6, /* syncTime= */ null,
          /* baseUri= */ '', /* startByte= */ 0, /* endByte= */ null);
      partialRef3.partial = true;

      const preloadRef = makeReference(
          'test:/partial.mp4', 6, 7.5, /* syncTime= */ null,
          /* baseUri= */ '', /* startByte= */ 0, /* endByte= */ null);
      preloadRef.partial = true;
      preloadRef.markAsPreload();
      preloadRef.markAsNonIndependent();

      // ref2 is not fully published yet, so it doesn't have a segment uri.
      const ref2 = makeReference(
          '', 4, 7.5, /* syncTime= */ null,
          /* baseUri= */ '', /* startByte= */ 0, /* endByte= */ null,
          /* timestampOffset= */ 0, [partialRef3, preloadRef]);

      await testInitialManifest(master, mediaWithPartialSegments, [ref, ref2]);
    });

    it('parses streams with partial and preload hinted segments and BYTERANGE', async () => { // eslint-disable-line @stylistic/max-len
      playerInterface.isLowLatencyMode = () => true;
      const mediaWithPartialSegments = [
        '#EXTM3U\n',
        '#EXT-X-TARGETDURATION:5\n',
        '#EXT-X-PART-INF:PART-TARGET=1.5\n',
        '#EXT-X-MAP:URI="init.mp4"\n',
        '#EXT-X-MEDIA-SEQUENCE:0\n',
        // ref includes partialRef, partialRef2
        // partialRef
        '#EXT-X-PART:DURATION=2,URI="ref1.mp4",BYTERANGE=200@0,',
        'INDEPENDENT=YES\n',
        // partialRef2
        '#EXT-X-PART:DURATION=2,URI="ref1.mp4",BYTERANGE=230@200,',
        'INDEPENDENT=YES\n',
        '#EXTINF:4,\n',
        'ref1.mp4\n',
        // ref2 includes partialRef3, preloadRef
        // partialRef3
        '#EXT-X-PART:DURATION=2,URI="ref2.mp4",BYTERANGE=210@0,',
        'INDEPENDENT=YES\n',
        // preloadRef
        '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="ref2.mp4",BYTERANGE-START=210,',
        'BYTERANGE-LENGTH=210\n',
      ].join('');

      // If ReadableStream is defined we can apply some optimizations
      if (window.ReadableStream) {
        const ref = makeReference(
            'test:/ref1.mp4', 0, 4, /* syncTime= */ null,
            /* baseUri= */ '', /* startByte= */ 0, /* endByte= */ null,
            /* timestampOffset= */ 0);
        ref.markAsByterangeOptimization();

        // ref2 is not fully published yet, so it doesn't have a segment uri.
        const ref2 = makeReference(
            'test:/ref2.mp4', 4, 7.5, /* syncTime= */ null,
            /* baseUri= */ '', /* startByte= */ 0, /* endByte= */ null,
            /* timestampOffset= */ 0);
        ref2.markAsByterangeOptimization();
        ref2.markAsPreload();

        await testInitialManifest(master, mediaWithPartialSegments,
            [ref, ref2]);
      } else {
        const partialRef = makeReference(
            'test:/ref1.mp4', 0, 2, /* syncTime= */ null,
            /* baseUri= */ '', /* startByte= */ 0, /* endByte= */ 199);

        const partialRef2 = makeReference(
            'test:/ref1.mp4', 2, 4, /* syncTime= */ null,
            /* baseUri= */ '', /* startByte= */ 200, /* endByte= */ 429);

        const ref = makeReference(
            'test:/ref1.mp4', 0, 4, /* syncTime= */ null,
            /* baseUri= */ '', /* startByte= */ 0, /* endByte= */ 429,
            /* timestampOffset= */ 0, [partialRef, partialRef2]);
        ref.allPartialSegments = true;

        const partialRef3 = makeReference(
            'test:/ref2.mp4', 4, 6, /* syncTime= */ null,
            /* baseUri= */ '', /* startByte= */ 0, /* endByte= */ 209);

        const preloadRef = makeReference(
            'test:/ref2.mp4', 6, 7.5, /* syncTime= */ null,
            /* baseUri= */ '', /* startByte= */ 210, /* endByte= */ 419);
        preloadRef.markAsPreload();
        preloadRef.markAsNonIndependent();

        // ref2 is not fully published yet, so it doesn't have a segment uri.
        const ref2 = makeReference(
            '', 4, 7.5, /* syncTime= */ null,
            /* baseUri= */ '', /* startByte= */ 0, /* endByte= */ 419,
            /* timestampOffset= */ 0, [partialRef3, preloadRef]);

        await testInitialManifest(master, mediaWithPartialSegments,
            [ref, ref2]);
      }
    });

    // Test for https://github.com/shaka-project/shaka-player/issues/4223
    it('ignores preload hinted segments without target duration', async () => {
      playerInterface.isLowLatencyMode = () => true;

      // Missing PART-TARGET, so preload hints are skipped.
      const mediaWithPartialSegments = [
        '#EXTM3U\n',
        '#EXT-X-TARGETDURATION:5\n',
        '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
        '#EXT-X-MEDIA-SEQUENCE:0\n',
        '#EXTINF:4,\n',
        // ref1
        'main.mp4\n',
        // ref2 includes partialRef, but not preloadRef
        // partialRef
        '#EXT-X-PART:DURATION=2,URI="partial.mp4",INDEPENDENT=YES\n',
        // preloadRef
        '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="partial.mp4"\n',
      ].join('');

      const ref = makeReference(
          'test:/main.mp4', 0, 4, /* syncTime= */ null,
          /* baseUri= */ '', /* startByte= */ 0, /* endByte= */ null,
          /* timestampOffset= */ 0, []);

      const partialRef = makeReference(
          'test:/partial.mp4', 4, 6, /* syncTime= */ null,
          /* baseUri= */ '', /* startByte= */ 0, /* endByte= */ null);

      // ref2 is not fully published yet, so it doesn't have a segment uri.
      const ref2 = makeReference(
          '', 4, 6, /* syncTime= */ null,
          /* baseUri= */ '', /* startByte= */ 0, /* endByte= */ null,
          /* timestampOffset= */ 0, [partialRef]);

      await testInitialManifest(master, mediaWithPartialSegments, [ref, ref2]);
    });

    // Test for https://github.com/shaka-project/shaka-player/issues/4185
    it('does not fail on preload hints with LL mode off', async () => {
      // LL mode must be off for this test!
      playerInterface.isLowLatencyMode = () => false;

      const mediaWithPartialSegments = [
        '#EXTM3U\n',
        '#EXT-X-TARGETDURATION:5\n',
        '#EXT-X-PART-INF:PART-TARGET=1.5\n',
        '#EXTINF:4,\n',
        'main.mp4\n',
        '#EXT-X-PART:DURATION=2,URI="partial.mp4",BYTERANGE=210@0\n',
        '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="partial.mp4",BYTERANGE-START=210\n',
      ].join('');

      // If this throws, the test fails.  Otherwise, it passes.
      await testInitialManifest(master, mediaWithPartialSegments);
    });

    describe('update', () => {
      it('adds new segments when they appear', async () => {
        const ref1 = makeReference(
            'test:/main.mp4', 0, 2, /* syncTime= */ null);
        const ref2 = makeReference(
            'test:/main2.mp4', 2, 4, /* syncTime= */ null);

        const manifest = await testInitialManifest(master, media, [ref1]);
        await testUpdate(manifest, mediaWithAdditionalSegment, [ref1, ref2]);
      });

      it('evicts removed segments', async () => {
        const ref1 = makeReference(
            'test:/main.mp4', 0, 2, /* syncTime= */ null);
        const ref2 = makeReference(
            'test:/main2.mp4', 2, 4, /* syncTime= */ null);

        const manifest = await testInitialManifest(
            master, mediaWithAdditionalSegment, [ref1, ref2]);
        await testUpdate(manifest, mediaWithRemovedSegment, [ref2]);
      });

      it('has correct references if switching after update', async () => {
        const ref1 = makeReference(
            'test:/main.mp4', 0, 2, /* syncTime= */ null);
        const ref2 = makeReference(
            'test:/main2.mp4', 2, 4, /* syncTime= */ null);
        const ref4 = makeReference(
            'test:/main4.mp4', 2, 4, /* syncTime= */ null);

        const secondVariant = [
          '#EXT-X-STREAM-INF:BANDWIDTH=300,CODECS="avc1",',
          'RESOLUTION=1200x940,FRAME-RATE=60\n',
          'video2',
        ].join('');
        const masterWithTwoVariants = master + secondVariant;
        configureNetEngineForInitialManifest(masterWithTwoVariants,
            mediaWithAdditionalSegment, mediaWithAdditionalSegment2);

        const manifest = await parser.start('test:/master', playerInterface);
        await manifest.variants[0].video.createSegmentIndex();
        ManifestParser.verifySegmentIndex(
            manifest.variants[0].video, [ref1, ref2]);
        expect(manifest.variants[1].video.segmentIndex).toBeNull();

        // Update.
        fakeNetEngine
            .setResponseText('test:/video', mediaWithRemovedSegment)
            .setResponseText('test:/video2', mediaWithRemovedSegment2);
        await delayForUpdatePeriod();

        // Switch.
        await manifest.variants[0].video.closeSegmentIndex();
        await manifest.variants[1].video.createSegmentIndex();

        // Check for variants to be as expected.
        expect(manifest.variants[0].video.segmentIndex).toBeNull();
        ManifestParser.verifySegmentIndex(
            manifest.variants[1].video, [ref4]);
      });

      describe('when ignoreManifestProgramDateTime is set', () => {
        const config = shaka.util.PlayerConfiguration.createDefault().manifest;
        config.hls.ignoreManifestProgramDateTime = true;

        it('does not reset segment times when switching', async () => {
          parser.configure(config);

          const ref1 = makeReference(
              'test:/main.mp4', 0, 2, /* syncTime= */ null);
          const ref2 = makeReference(
              'test:/main2.mp4', 2, 4, /* syncTime= */ null);

          const secondVariant = [
            '#EXT-X-STREAM-INF:BANDWIDTH=300,CODECS="avc1",',
            'RESOLUTION=1200x940,FRAME-RATE=60\n',
            'video2',
          ].join('');
          const masterWithTwoVariants = master + secondVariant;
          configureNetEngineForInitialManifest(masterWithTwoVariants,
              mediaWithAdditionalSegment, mediaWithAdditionalSegment2);

          const manifest = await parser.start('test:/master', playerInterface);
          await manifest.variants[0].video.createSegmentIndex();
          ManifestParser.verifySegmentIndex(
              manifest.variants[0].video, [ref1, ref2]);
          expect(manifest.variants[1].video.segmentIndex).toBeNull();

          // In the initial playlist, we know the earliest start time is 0, at
          // EXT-X-MEDIA-SEQUENCE of 0.
          expect(
              manifest.variants[0].video.segmentIndex.earliestReference()
                  .getStartTime())
              .toBe(0);

          // Update.
          fakeNetEngine
              .setResponseText('test:/video', mediaWithRemovedSegment)
              .setResponseText('test:/video2', mediaWithRemovedSegment2);
          await delayForUpdatePeriod();

          // Switch. The new variant starts at EXT-X-MEDIA-SEQUENCE of 1.
          await manifest.variants[0].video.closeSegmentIndex();
          await manifest.variants[1].video.createSegmentIndex();

          // The earliest start time of the new segmentIndex should therefore be
          // 2.
          expect(manifest.variants[0].video.segmentIndex).toBeNull();
          const segIdx = manifest.variants[1].video.segmentIndex;
          expect(segIdx.earliestReference().getStartTime()).toBe(2);
        });
      });

      it('handles switching during update', async () => {
        const ref1 = makeReference(
            'test:/main.mp4', 0, 2, /* syncTime= */ null);
        const ref2 = makeReference(
            'test:/main2.mp4', 2, 4, /* syncTime= */ null);
        const ref4 = makeReference(
            'test:/main4.mp4', 2, 4, /* syncTime= */ null);

        const secondVariant = [
          '#EXT-X-STREAM-INF:BANDWIDTH=300,CODECS="avc1",',
          'RESOLUTION=1200x940,FRAME-RATE=60\n',
          'video2',
        ].join('');
        const masterWithTwoVariants = master + secondVariant;
        configureNetEngineForInitialManifest(masterWithTwoVariants,
            mediaWithAdditionalSegment, mediaWithAdditionalSegment2);

        const manifest = await parser.start('test:/master', playerInterface);
        await manifest.variants[0].video.createSegmentIndex();
        ManifestParser.verifySegmentIndex(
            manifest.variants[0].video, [ref1, ref2]);
        expect(manifest.variants[1].video.segmentIndex).toBe(null);

        // Update.
        fakeNetEngine
            .setResponseText('test:/video', mediaWithRemovedSegment)
            .setResponseText('test:/video2', mediaWithRemovedSegment2);

        const updatePromise = parser.update();

        // Verify that the update is not yet complete.
        expect(manifest.variants[0].video.segmentIndex).not.toBe(null);
        ManifestParser.verifySegmentIndex(
            manifest.variants[0].video, [ref1, ref2]);

        // Mid-update, switch.
        await manifest.variants[0].video.closeSegmentIndex();
        await manifest.variants[1].video.createSegmentIndex();

        // Finish the update.
        await updatePromise;

        // Check for variants to be as expected.
        expect(manifest.variants[0].video.segmentIndex).toBe(null);
        ManifestParser.verifySegmentIndex(
            manifest.variants[1].video, [ref4]);
      });

      it('handles updates with redirects', async () => {
        const oldRef1 = makeReference(
            'test:/main.mp4', 0, 2, /* syncTime= */ null);

        const newRef1 = makeReference(
            ['test:/redirected/main.mp4', 'test:/main.mp4'],
            0, 2, /* syncTime= */ null);
        const newRef2 = makeReference(
            ['test:/redirected/main2.mp4', 'test:/main2.mp4'],
            2, 4, /* syncTime= */ null);

        let playlistFetchCount = 0;

        fakeNetEngine.setResponseFilter((type, response) => {
          // Simulate a redirect on the updated playlist by changing the
          // response URI on the second playlist fetch.
          if (response.uri == 'test:/video') {
            playlistFetchCount++;
            if (playlistFetchCount == 2) {
              response.uri = 'test:/redirected/video';
            }
          }
        });

        const manifest = await testInitialManifest(master, media, [oldRef1]);
        await testUpdate(
            manifest, mediaWithAdditionalSegment, [newRef1, newRef2]);
      });

      it('parses start time from mp4 segments', async () => {
        const ref = makeReference(
            'test:/main.mp4', 0, 2, /* syncTime= */ null);
        // In live content, we do not set timestampOffset.
        ref.timestampOffset = 0;

        await testInitialManifest(master, media, [ref]);
      });

      it('gets start time on update without segment request', async () => {
        const ref1 = makeReference(
            'test:/main.mp4', 0, 2, /* syncTime= */ null);

        const ref2 = makeReference(
            'test:/main2.mp4', 2, 4, /* syncTime= */ null);

        const manifest = await testInitialManifest(
            master, mediaWithAdditionalSegment, [ref1, ref2]);

        fakeNetEngine.request.calls.reset();
        await testUpdate(manifest, mediaWithRemovedSegment, [ref2]);

        // Only one request was made, and it was for the playlist.
        // No segment requests were needed to get the start time.
        expect(fakeNetEngine.request).toHaveBeenCalledTimes(1);
        const type =
            shaka.net.NetworkingEngine.AdvancedRequestType.MEDIA_PLAYLIST;
        fakeNetEngine.expectRequest(
            'test:/video',
            shaka.net.NetworkingEngine.RequestType.MANIFEST,
            {type});
      });

      it('request playlist delta updates to skip segments', async () => {
        const mediaWithDeltaUpdates = [
          '#EXTM3U\n',
          '#EXT-X-PLAYLIST-TYPE:LIVE\n',
          '#EXT-X-TARGETDURATION:5\n',
          '#EXT-X-MEDIA-SEQUENCE:0\n',
          '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
          '#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,CAN-SKIP-UNTIL=60.0,\n',
          '#EXTINF:2,\n',
          'main0.mp4\n',
          '#EXTINF:2,\n',
          'main1.mp4\n',
        ].join('');

        const mediaWithSkippedSegments1 = [
          '#EXTM3U\n',
          '#EXT-X-TARGETDURATION:5\n',
          '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
          '#EXT-X-MEDIA-SEQUENCE:1\n',
          '#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,CAN-SKIP-UNTIL=60.0,\n',
          '#EXT-X-SKIP:SKIPPED-SEGMENTS=1\n',
          '#EXTINF:2,\n',
          'main1.mp4\n',
          '#EXTINF:2,\n',
          'main2.mp4\n',
        ].join('');

        const mediaWithSkippedSegments2 = [
          '#EXTM3U\n',
          '#EXT-X-TARGETDURATION:5\n',
          '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
          '#EXT-X-MEDIA-SEQUENCE:2\n',
          '#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,CAN-SKIP-UNTIL=60.0,\n',
          '#EXT-X-SKIP:SKIPPED-SEGMENTS=1\n',
          '#EXTINF:2,\n',
          'main2.mp4\n',
          '#EXTINF:2,\n',
          'main3.mp4\n',
        ].join('');

        fakeNetEngine.setResponseText(
            'test:/video?_HLS_msn=2&_HLS_skip=YES', mediaWithSkippedSegments1);

        fakeNetEngine.setResponseText(
            'test:/video?_HLS_msn=4&_HLS_skip=YES', mediaWithSkippedSegments2);

        playerInterface.isLowLatencyMode = () => true;

        await testInitialManifest(master, mediaWithDeltaUpdates);

        fakeNetEngine.request.calls.reset();

        await delayForUpdatePeriod();
        fakeNetEngine.expectRequest(
            'test:/video?_HLS_msn=2&_HLS_skip=YES',
            shaka.net.NetworkingEngine.RequestType.MANIFEST,
            {type:
              shaka.net.NetworkingEngine.AdvancedRequestType.MEDIA_PLAYLIST});

        await delayForUpdatePeriod();
        fakeNetEngine.expectRequest(
            'test:/video?_HLS_msn=4&_HLS_skip=YES',
            shaka.net.NetworkingEngine.RequestType.MANIFEST,
            {type:
              shaka.net.NetworkingEngine.AdvancedRequestType.MEDIA_PLAYLIST});
      });

      // eslint-disable-next-line @stylistic/max-len
      it('request playlist delta updates to skip segments and EXT-X-DATERANGE', async () => {
        const mediaWithDeltaUpdates = [
          '#EXTM3U\n',
          '#EXT-X-PLAYLIST-TYPE:LIVE\n',
          '#EXT-X-TARGETDURATION:5\n',
          '#EXT-X-MEDIA-SEQUENCE:0\n',
          '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
          '#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,CAN-SKIP-UNTIL=60.0,',
          'CAN-SKIP-DATERANGES=YES\n',
          '#EXTINF:2,\n',
          'main0.mp4\n',
          '#EXTINF:2,\n',
          'main1.mp4\n',
        ].join('');

        const mediaWithSkippedSegments1 = [
          '#EXTM3U\n',
          '#EXT-X-TARGETDURATION:5\n',
          '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
          '#EXT-X-MEDIA-SEQUENCE:1\n',
          '#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,CAN-SKIP-UNTIL=60.0,',
          'CAN-SKIP-DATERANGES=YES\n',
          '#EXT-X-SKIP:SKIPPED-SEGMENTS=1\n',
          '#EXTINF:2,\n',
          'main1.mp4\n',
          '#EXTINF:2,\n',
          'main2.mp4\n',
        ].join('');

        const mediaWithSkippedSegments2 = [
          '#EXTM3U\n',
          '#EXT-X-TARGETDURATION:5\n',
          '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
          '#EXT-X-MEDIA-SEQUENCE:2\n',
          '#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,CAN-SKIP-UNTIL=60.0,',
          'CAN-SKIP-DATERANGES=YES\n',
          '#EXT-X-SKIP:SKIPPED-SEGMENTS=1\n',
          '#EXTINF:2,\n',
          'main2.mp4\n',
          '#EXTINF:2,\n',
          'main3.mp4\n',
        ].join('');

        fakeNetEngine.setResponseText(
            'test:/video?_HLS_msn=2&_HLS_skip=v2', mediaWithSkippedSegments1);

        fakeNetEngine.setResponseText(
            'test:/video?_HLS_msn=4&_HLS_skip=v2', mediaWithSkippedSegments2);

        playerInterface.isLowLatencyMode = () => true;

        await testInitialManifest(master, mediaWithDeltaUpdates);

        fakeNetEngine.request.calls.reset();

        await delayForUpdatePeriod();
        fakeNetEngine.expectRequest(
            'test:/video?_HLS_msn=2&_HLS_skip=v2',
            shaka.net.NetworkingEngine.RequestType.MANIFEST,
            {type:
              shaka.net.NetworkingEngine.AdvancedRequestType.MEDIA_PLAYLIST});

        await delayForUpdatePeriod();
        fakeNetEngine.expectRequest(
            'test:/video?_HLS_msn=4&_HLS_skip=v2',
            shaka.net.NetworkingEngine.RequestType.MANIFEST,
            {type:
              shaka.net.NetworkingEngine.AdvancedRequestType.MEDIA_PLAYLIST});
      });

      it('skips older segments', async () => {
        const mediaWithSkippedSegments = [
          '#EXTM3U\n',
          '#EXT-X-TARGETDURATION:5\n',
          '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
          '#EXT-X-MEDIA-SEQUENCE:0\n',
          '#EXT-X-SKIP:SKIPPED-SEGMENTS=1\n',
          '#EXTINF:2,\n',
          'main2.mp4\n',
          '#EXTINF:2,\n',
          'main3.mp4\n',
        ].join('');

        playerInterface.isLowLatencyMode = () => true;
        const ref1 = makeReference(
            'test:/main.mp4', 0, 2, /* syncTime= */ null);
        const ref2 = makeReference(
            'test:/main2.mp4', 2, 4, /* syncTime= */ null);
        const ref3 = makeReference(
            'test:/main3.mp4', 4, 6, /* syncTime= */ null);

        const manifest = await testInitialManifest(
            master, mediaWithAdditionalSegment, [ref1, ref2]);

        // With 'SKIPPED-SEGMENTS', ref1 is skipped from the playlist,
        // and ref1 should be in the SegmentReferences list.
        // ref3 should be appended to the SegmentReferences list.
        await testUpdate(
            manifest, mediaWithSkippedSegments, [ref1, ref2, ref3]);
      });

      it('skips older segments with discontinuity', async () => {
        const mediaWithDiscontinuity2 = [
          '#EXTM3U\n',
          '#EXT-X-PLAYLIST-TYPE:LIVE\n',
          '#EXT-X-TARGETDURATION:5\n',
          '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
          '#EXT-X-DISCONTINUITY-SEQUENCE:30\n',
          '#EXTINF:2,\n',
          'main.mp4\n',
          '#EXT-X-DISCONTINUITY\n',
          '#EXTINF:2,\n',
          'main2.mp4\n',
          '#EXTINF:2,\n',
          'main3.mp4\n',
        ].join('');

        const mediaWithSkippedSegments2 = [
          '#EXTM3U\n',
          '#EXT-X-TARGETDURATION:5\n',
          '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
          '#EXT-X-MEDIA-SEQUENCE:0\n',
          '#EXT-X-DISCONTINUITY-SEQUENCE:30\n',
          '#EXT-X-SKIP:SKIPPED-SEGMENTS=2\n',
          '#EXTINF:2,\n',
          'main3.mp4\n',
          '#EXTINF:2,\n',
          'main4.mp4\n',
        ].join('');

        playerInterface.isLowLatencyMode = () => true;

        const ref1 = makeReference(
            'test:/main.mp4', 0, 2, /* syncTime= */ null,
            /* baseUri= */ '', /* startByte= */ 0, /* endByte= */ null,
            /* timestampOffset= */ 0);

        // Expect the timestamp offset to be set for the segment after the
        // EXT-X-DISCONTINUITY tag.
        const ref2 = makeReference(
            'test:/main2.mp4', 2, 4, /* syncTime= */ null,
            /* baseUri= */ '', /* startByte= */ 0, /* endByte= */ null,
            /* timestampOffset= */ 0);

        // Expect the timestamp offset to be set for the segment, with the
        // EXT-X-DISCONTINUITY tag skipped in the playlist.
        const ref3 = makeReference(
            'test:/main3.mp4', 4, 6, /* syncTime= */ null,
            /* baseUri= */ '', /* startByte= */ 0, /* endByte= */ null,
            /* timestampOffset= */ 0);

        const ref4 = makeReference(
            'test:/main4.mp4', 6, 8, /* syncTime= */ null,
            /* baseUri= */ '', /* startByte= */ 0, /* endByte= */ null,
            /* timestampOffset= */ 0);

        const manifest = await testInitialManifest(
            master, mediaWithDiscontinuity2, [ref1, ref2, ref3]);

        // With 'SKIPPED-SEGMENTS', ref1, ref2 are skipped from the playlist,
        // and ref1,ref2 should be in the SegmentReferences list.
        // ref3,ref4 should be appended to the SegmentReferences list.
        await testUpdate(
            manifest, mediaWithSkippedSegments2, [ref1, ref2, ref3, ref4]);
      });

      it('updates encryption keys', async () => {
        const initialKey = 'abc123';
        const media = [
          '#EXTM3U\n',
          '#EXT-X-TARGETDURATION:6\n',
          '#EXT-X-PLAYLIST-TYPE:EVENT\n',
          '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,',
          'KEYID=0X' + initialKey + ',',
          'KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",',
          'URI="data:text/plain;base64,',
          'dGhpcyBpbml0IGRhdGEgY29udGFpbnMgaGlkZGVuIHNlY3JldHMhISE', '",\n',
          '#EXT-X-MAP:URI="init.mp4"\n',
          '#EXTINF:5,\n',
          '#EXT-X-BYTERANGE:121090@616\n',
          'main.mp4',
        ].join('');

        const updatedKey = 'xyz345';
        const updatedMedia = [
          '#EXTM3U\n',
          '#EXT-X-TARGETDURATION:6\n',
          '#EXT-X-PLAYLIST-TYPE:EVENT\n',
          '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,',
          'KEYID=0X' + updatedKey + ',',
          'KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",',
          'URI="data:text/plain;base64,',
          'dGhpcyBpbml0IGRhdGEgY29udGFpbnMgaGlkZGVuIHNlY3JldHMhISE', '",\n',
          '#EXT-X-MAP:URI="init.mp4"\n',
          '#EXTINF:5,\n',
          '#EXT-X-BYTERANGE:121090@616\n',
          'main.mp4',
        ].join('');

        const manifest = await testInitialManifest(master, media, null);
        await testUpdate(manifest, updatedMedia, null);
        const keys = Array.from(manifest.variants[0].video.keyIds);
        expect(keys[0]).toBe(updatedKey);
      });
    });  // describe('update')

    describe('createSegmentIndex', () => {
      it('handles multiple concurrent calls', async () => {
        const secondVariant = [
          '#EXT-X-STREAM-INF:BANDWIDTH=300,CODECS="avc1",',
          'RESOLUTION=1200x940,FRAME-RATE=60\n',
          'video2',
        ].join('');
        const masterWithTwoVariants = master + secondVariant;
        configureNetEngineForInitialManifest(masterWithTwoVariants,
            mediaWithAdditionalSegment, mediaWithAdditionalSegment2);

        const manifest = await parser.start('test:/master', playerInterface);

        // No segment index yet.
        expect(manifest.variants[0].video.segmentIndex).toBe(null);

        // Make two calls to create the segment index.
        const created1 = manifest.variants[0].video.createSegmentIndex();
        const created2 = manifest.variants[0].video.createSegmentIndex();

        // Still no segment index yet.
        expect(manifest.variants[0].video.segmentIndex).toBe(null);

        // Without caring what order these Promises complete in, we should be
        // able to see that neither resolves without a full segment index being
        // ready.
        created1.then(() => {
          expect(manifest.variants[0].video.segmentIndex).not.toBe(null);
        });
        created2.then(() => {
          expect(manifest.variants[0].video.segmentIndex).not.toBe(null);
        });

        // Now wait for both Promises to resolve.
        await Promise.all([created1, created2]);
      });

      it('handles switching during createSegmentIndex', async () => {
        const secondVariant = [
          '#EXT-X-STREAM-INF:BANDWIDTH=300,CODECS="avc1",',
          'RESOLUTION=1200x940,FRAME-RATE=60\n',
          'video2',
        ].join('');
        const masterWithTwoVariants = master + secondVariant;
        configureNetEngineForInitialManifest(masterWithTwoVariants,
            mediaWithAdditionalSegment, mediaWithAdditionalSegment2);

        const manifest = await parser.start('test:/master', playerInterface);

        // No segment index yet.
        expect(manifest.variants[0].video.segmentIndex).toBe(null);

        // Make a call to create the segment index.
        const created1 = manifest.variants[0].video.createSegmentIndex();

        // Still no segment index yet.
        expect(manifest.variants[0].video.segmentIndex).toBe(null);

        // Mid-create, switch.
        await manifest.variants[0].video.closeSegmentIndex();
        const created2 = manifest.variants[1].video.createSegmentIndex();

        // Finish the original creation call.
        await created1;

        // The first segment index should never have been created, because the
        // close call should have cancelled the work in progress.
        expect(manifest.variants[0].video.segmentIndex).toBe(null);

        // Finish the second creation call.
        await created2;

        // The second segment index is complete, because the create call was
        // never interrupted.
        expect(manifest.variants[1].video.segmentIndex).not.toBe(null);
      });
    });  // describe('createSegmentIndex')
  });  // describe('playlist type LIVE')

  it('Live updates: adds new chapter when new segments arrive', async () => {
    async function loadAllStreamsFor(manifest) {
      const promises = [];
      for (const stream of [
        ...(manifest.videoStreams || []),
        ...(manifest.audioStreams || []),
        ...(manifest.textStreams || []),
        ...(manifest.chapterStreams || []),
      ]) {
        if (!stream.segmentIndex) {
          promises.push(stream.createSegmentIndex());
        }
      }
      await Promise.all(promises);
    }

    const master = [
      '#EXTM3U\n',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub1",LANGUAGE="eng",URI="text"\n',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",LANGUAGE="eng",CHANNELS="2",',
      'URI="audio"\n',
      '#EXT-X-STREAM-INF:BANDWIDTH=200,CODECS="avc1,mp4a",',
      'AUDIO="aud1",SUBTITLES="sub1"\n',
      'video\n',
      '#EXT-X-SESSION-DATA:DATA-ID="com.apple.hls.chapters",',
      'URI="chapters.json"\n',
    ].join('');

    const videoLive1 = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:5\n',
      '#EXT-X-MEDIA-SEQUENCE:0\n',
      '#EXTINF:5,\n',
      'main1.mp4\n',
    ].join('');

    const videoLive2 = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:5\n',
      '#EXT-X-MEDIA-SEQUENCE:0\n',
      '#EXTINF:5,\n',
      'main1.mp4\n',
      '#EXTINF:5,\n',
      'main2.mp4\n',
    ].join('');

    const audioLive = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:5\n',
      '#EXT-X-MEDIA-SEQUENCE:0\n',
      '#EXTINF:5,\n',
      'audio1.mp4\n',
    ].join('');

    const textLive = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:5\n',
      '#EXT-X-MEDIA-SEQUENCE:0\n',
      '#EXTINF:5,\n',
      'main.vtt\n',
    ].join('');

    const chaptersJson1 = JSON.stringify([
      {
        'chapter': 1,
        'start-time': 0,
        'duration': 5,
        'titles': [
          {
            language: 'en',
            title: 'Intro',
          },
        ],
      },
    ]);

    const chaptersJson2 = JSON.stringify([
      {
        'chapter': 1,
        'start-time': 0,
        'duration': 5,
        'titles': [
          {
            language: 'en',
            title: 'Intro',
          },
        ],
      },
      {
        'chapter': 2,
        'start-time': 5,
        'duration': 5,
        'titles': [
          {
            language: 'en',
            title: 'Live Part 1',
          },
        ],
      },
    ]);

    /** @type {!jasmine.Spy} */
    const onEvent = jasmine.createSpy('onEvent');
    playerInterface.onEvent = shaka.test.Util.spyFunc(onEvent);

    fakeNetEngine
        .setResponseText('test:/master', master)
        .setResponseText('test:/video', videoLive1)
        .setResponseText('test:/audio', audioLive)
        .setResponseText('test:/text', textLive)
        .setResponseText('test:/chapters.json', chaptersJson1)
        .setResponseValue('test:/main1.mp4', segmentData)
        .setResponseValue('test:/main2.mp4', segmentData);

    const actual = await parser.start('test:/master', playerInterface);

    await loadAllStreamsFor(actual);
    expect(actual.chapterStreams.length).toBe(1);
    const chapters = actual.chapterStreams[0];
    expect(chapters).toBeDefined();

    await chapters.createSegmentIndex();
    const segmentIndex = chapters.segmentIndex;
    expect(segmentIndex.getNumReferences()).toBe(1);
    expect(segmentIndex.get(0).getMetadata().title).toBe('Intro');

    fakeNetEngine.setResponseText('test:/video', videoLive2);
    fakeNetEngine.setResponseText('test:/chapters.json', chaptersJson2);

    await parser.update();

    expect(segmentIndex.getNumReferences()).toBe(2);
    expect(segmentIndex.get(0).getMetadata().title).toBe('Intro');
    expect(segmentIndex.get(1).getMetadata().title).toBe('Live Part 1');
  });

  it('Live updates: adds new chapter streams', async () => {
    async function loadAllStreamsFor(manifest) {
      const promises = [];
      for (const stream of [
        ...(manifest.videoStreams || []),
        ...(manifest.audioStreams || []),
        ...(manifest.textStreams || []),
        ...(manifest.chapterStreams || []),
      ]) {
        if (!stream.segmentIndex) {
          promises.push(stream.createSegmentIndex());
        }
      }
      await Promise.all(promises);
    }

    const master = [
      '#EXTM3U\n',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub1",LANGUAGE="eng",URI="text"\n',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",LANGUAGE="eng",CHANNELS="2",',
      'URI="audio"\n',
      '#EXT-X-STREAM-INF:BANDWIDTH=200,CODECS="avc1,mp4a",',
      'AUDIO="aud1",SUBTITLES="sub1"\n',
      'video\n',
      '#EXT-X-SESSION-DATA:DATA-ID="com.apple.hls.chapters",',
      'URI="chapters.json"\n',
    ].join('');

    const videoLive1 = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:5\n',
      '#EXT-X-MEDIA-SEQUENCE:0\n',
      '#EXTINF:5,\n',
      'main1.mp4\n',
    ].join('');

    const videoLive2 = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:5\n',
      '#EXT-X-MEDIA-SEQUENCE:0\n',
      '#EXTINF:5,\n',
      'main1.mp4\n',
      '#EXTINF:5,\n',
      'main2.mp4\n',
    ].join('');

    const audioLive = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:5\n',
      '#EXT-X-MEDIA-SEQUENCE:0\n',
      '#EXTINF:5,\n',
      'audio1.mp4\n',
    ].join('');

    const textLive = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:5\n',
      '#EXT-X-MEDIA-SEQUENCE:0\n',
      '#EXTINF:5,\n',
      'main.vtt\n',
    ].join('');

    const chaptersJson1 = JSON.stringify([]);

    const chaptersJson2 = JSON.stringify([
      {
        'chapter': 1,
        'start-time': 0,
        'duration': 5,
        'titles': [
          {
            language: 'en',
            title: 'Intro',
          },
        ],
      },
    ]);

    /** @type {!jasmine.Spy} */
    const onEvent = jasmine.createSpy('onEvent');
    playerInterface.onEvent = shaka.test.Util.spyFunc(onEvent);

    fakeNetEngine
        .setResponseText('test:/master', master)
        .setResponseText('test:/video', videoLive1)
        .setResponseText('test:/audio', audioLive)
        .setResponseText('test:/text', textLive)
        .setResponseText('test:/chapters.json', chaptersJson1)
        .setResponseValue('test:/main1.mp4', segmentData)
        .setResponseValue('test:/main2.mp4', segmentData);

    const actual = await parser.start('test:/master', playerInterface);

    await loadAllStreamsFor(actual);
    expect(actual.chapterStreams.length).toBe(0);

    fakeNetEngine.setResponseText('test:/video', videoLive2);
    fakeNetEngine.setResponseText('test:/chapters.json', chaptersJson2);

    await parser.update();

    await loadAllStreamsFor(actual);
    expect(actual.chapterStreams.length).toBe(1);
    const chapters = actual.chapterStreams[0];
    expect(chapters).toBeDefined();

    await chapters.createSegmentIndex();
    const segmentIndex = chapters.segmentIndex;
    expect(segmentIndex.getNumReferences()).toBe(1);
    expect(segmentIndex.get(0).getMetadata().title).toBe('Intro');
  });

  /**
   * @param {string | Array<string>} uri A relative URI to http://example.com
   * @param {number} start
   * @param {number} end
   * @param {?number} syncTime
   * @param {string=} baseUri
   * @param {number=} startByte
   * @param {?number=} endByte
   * @param {number=} timestampOffset
   * @param {!Array<!shaka.media.SegmentReference>=} partialReferences
   * @param {?string=} tilesLayout
   * @return {!shaka.media.SegmentReference}
   */
  function makeReference(uri, start, end, syncTime, baseUri, startByte, endByte,
      timestampOffset, partialReferences, tilesLayout) {
    return ManifestParser.makeReference(uri, start, end, baseUri, startByte,
        endByte, timestampOffset, partialReferences, tilesLayout, syncTime);
  }

  it('preserves A/V EXTINF reconciliation across live updates', async () => {
    config.hls.ignoreManifestProgramDateTime = true;
    parser.configure(config);

    // Master with separate AUDIO group
    const masterPlaylist = [
      '#EXTM3U\n',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",LANGUAGE="eng",',
      'URI="audio"\n',
      '#EXT-X-STREAM-INF:BANDWIDTH=200,CODECS="avc1,mp4a",',
      'RESOLUTION=960x540,FRAME-RATE=60,AUDIO="aud1"\n',
      'video\n',
    ].join('');

    // Video: 2 segments per disc block, 5s EXTINF
    const videoInitial = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:6\n',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
      '#EXT-X-MEDIA-SEQUENCE:0\n',
      '#EXT-X-DISCONTINUITY-SEQUENCE:0\n',
      '#EXTINF:5,\n',
      'v0.mp4\n',
      '#EXTINF:5,\n',
      'v1.mp4\n',
      '#EXT-X-DISCONTINUITY\n',
      '#EXTINF:5,\n',
      'v2.mp4\n',
      '#EXTINF:5,\n',
      'v3.mp4\n',
    ].join('');

    // Audio: 2 segments per disc block, 5.01s EXTINF (AAC rounding)
    const audioInitial = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:6\n',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
      '#EXT-X-MEDIA-SEQUENCE:0\n',
      '#EXT-X-DISCONTINUITY-SEQUENCE:0\n',
      '#EXTINF:5.01,\n',
      'a0.mp4\n',
      '#EXTINF:5.01,\n',
      'a1.mp4\n',
      '#EXT-X-DISCONTINUITY\n',
      '#EXTINF:5.01,\n',
      'a2.mp4\n',
      '#EXTINF:5.01,\n',
      'a3.mp4\n',
    ].join('');

    // Updated: window slides — seq0 evicted, seq4 added
    const videoUpdated = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:6\n',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
      '#EXT-X-MEDIA-SEQUENCE:1\n',
      '#EXT-X-DISCONTINUITY-SEQUENCE:0\n',
      '#EXTINF:5,\n',
      'v1.mp4\n',
      '#EXT-X-DISCONTINUITY\n',
      '#EXTINF:5,\n',
      'v2.mp4\n',
      '#EXTINF:5,\n',
      'v3.mp4\n',
      '#EXTINF:5,\n',
      'v4.mp4\n',
    ].join('');

    const audioUpdated = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:6\n',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
      '#EXT-X-MEDIA-SEQUENCE:1\n',
      '#EXT-X-DISCONTINUITY-SEQUENCE:0\n',
      '#EXTINF:5.01,\n',
      'a1.mp4\n',
      '#EXT-X-DISCONTINUITY\n',
      '#EXTINF:5.01,\n',
      'a2.mp4\n',
      '#EXTINF:5.01,\n',
      'a3.mp4\n',
      '#EXTINF:5.01,\n',
      'a4.mp4\n',
    ].join('');

    fakeNetEngine
        .setResponseText('test:/master', masterPlaylist)
        .setResponseText('test:/video', videoInitial)
        .setResponseText('test:/audio', audioInitial)
        .setResponseValue('test:/init.mp4', initSegmentData)
        .setResponseValue('test:/v0.mp4', segmentData)
        .setResponseValue('test:/v1.mp4', segmentData)
        .setResponseValue('test:/v2.mp4', segmentData)
        .setResponseValue('test:/v3.mp4', segmentData)
        .setResponseValue('test:/v4.mp4', segmentData)
        .setResponseValue('test:/a0.mp4', segmentData)
        .setResponseValue('test:/a1.mp4', segmentData)
        .setResponseValue('test:/a2.mp4', segmentData)
        .setResponseValue('test:/a3.mp4', segmentData)
        .setResponseValue('test:/a4.mp4', segmentData);

    const manifest =
        await parser.start('test:/master', playerInterface);

    const actualVideo = manifest.variants[0].video;
    const actualAudio = manifest.variants[0].audio;
    await actualVideo.createSegmentIndex();
    await actualAudio.createSegmentIndex();
    goog.asserts.assert(actualVideo.segmentIndex != null, 'Null segmentIndex!');
    goog.asserts.assert(actualAudio.segmentIndex != null, 'Null segmentIndex!');

    // After initial load: disc boundary (block 1) should align
    const videoRefs = Array.from(actualVideo.segmentIndex);
    const audioRefs = Array.from(actualAudio.segmentIndex);

    // Block 1 starts at 10s for video, should also be ~10s for audio
    expect(Math.abs(videoRefs[2].startTime - audioRefs[2].startTime))
        .toBeLessThan(0.001);

    // Simulate live update: window slides
    fakeNetEngine
        .setResponseText('test:/video', videoUpdated)
        .setResponseText('test:/audio', audioUpdated);

    await delayForUpdatePeriod();

    // After update: alignment should still hold
    const videoIdx = actualVideo.segmentIndex;
    const audioIdx = actualAudio.segmentIndex;
    goog.asserts.assert(videoIdx != null, 'Null segmentIndex!');
    goog.asserts.assert(audioIdx != null, 'Null segmentIndex!');
    const videoRefsAfter = Array.from(videoIdx);
    const audioRefsAfter = Array.from(audioIdx);

    // Find disc boundary in updated segments (block 1 start)
    for (let i = 0; i < videoRefsAfter.length; i++) {
      const vRef = videoRefsAfter[i];
      const aRef = audioRefsAfter[i];
      if (i === 0 || videoRefsAfter[i - 1].discontinuitySequence !==
          vRef.discontinuitySequence) {
        expect(Math.abs(vRef.startTime - aRef.startTime))
            .toBeLessThan(0.001);
      }
    }
  });

  it('live update starting inside non-zero-offset disc block', async () => {
    config.hls.ignoreManifestProgramDateTime = true;
    parser.configure(config);

    const masterPlaylist = [
      '#EXTM3U\n',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",LANGUAGE="eng",',
      'URI="audio"\n',
      '#EXT-X-STREAM-INF:BANDWIDTH=200,CODECS="avc1,mp4a",',
      'RESOLUTION=960x540,FRAME-RATE=60,AUDIO="aud1"\n',
      'video\n',
    ].join('');

    // Initial: v0-v3 (5s), a0-a3 (5.01s), disc at seg 2
    const videoInitial = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:6\n',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
      '#EXT-X-MEDIA-SEQUENCE:0\n',
      '#EXT-X-DISCONTINUITY-SEQUENCE:0\n',
      '#EXTINF:5,\n',
      'v0.mp4\n',
      '#EXTINF:5,\n',
      'v1.mp4\n',
      '#EXT-X-DISCONTINUITY\n',
      '#EXTINF:5,\n',
      'v2.mp4\n',
      '#EXTINF:5,\n',
      'v3.mp4\n',
    ].join('');

    const audioInitial = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:6\n',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
      '#EXT-X-MEDIA-SEQUENCE:0\n',
      '#EXT-X-DISCONTINUITY-SEQUENCE:0\n',
      '#EXTINF:5.01,\n',
      'a0.mp4\n',
      '#EXTINF:5.01,\n',
      'a1.mp4\n',
      '#EXT-X-DISCONTINUITY\n',
      '#EXTINF:5.01,\n',
      'a2.mp4\n',
      '#EXTINF:5.01,\n',
      'a3.mp4\n',
    ].join('');

    // Update 1: v1-v4, a1-a4 (window slides, starts inside disc 0)
    const videoUpdate1 = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:6\n',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
      '#EXT-X-MEDIA-SEQUENCE:1\n',
      '#EXT-X-DISCONTINUITY-SEQUENCE:0\n',
      '#EXTINF:5,\n',
      'v1.mp4\n',
      '#EXT-X-DISCONTINUITY\n',
      '#EXTINF:5,\n',
      'v2.mp4\n',
      '#EXTINF:5,\n',
      'v3.mp4\n',
      '#EXTINF:5,\n',
      'v4.mp4\n',
    ].join('');

    const audioUpdate1 = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:6\n',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
      '#EXT-X-MEDIA-SEQUENCE:1\n',
      '#EXT-X-DISCONTINUITY-SEQUENCE:0\n',
      '#EXTINF:5.01,\n',
      'a1.mp4\n',
      '#EXT-X-DISCONTINUITY\n',
      '#EXTINF:5.01,\n',
      'a2.mp4\n',
      '#EXTINF:5.01,\n',
      'a3.mp4\n',
      '#EXTINF:5.01,\n',
      'a4.mp4\n',
    ].join('');

    // Update 2: v3-v6, a3-a6 (window slides INTO disc 1, no disc tag)
    const videoUpdate2 = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:6\n',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
      '#EXT-X-MEDIA-SEQUENCE:3\n',
      '#EXT-X-DISCONTINUITY-SEQUENCE:1\n',
      '#EXTINF:5,\n',
      'v3.mp4\n',
      '#EXTINF:5,\n',
      'v4.mp4\n',
      '#EXTINF:5,\n',
      'v5.mp4\n',
      '#EXTINF:5,\n',
      'v6.mp4\n',
    ].join('');

    const audioUpdate2 = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:6\n',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
      '#EXT-X-MEDIA-SEQUENCE:3\n',
      '#EXT-X-DISCONTINUITY-SEQUENCE:1\n',
      '#EXTINF:5.01,\n',
      'a3.mp4\n',
      '#EXTINF:5.01,\n',
      'a4.mp4\n',
      '#EXTINF:5.01,\n',
      'a5.mp4\n',
      '#EXTINF:5.01,\n',
      'a6.mp4\n',
    ].join('');

    fakeNetEngine
        .setResponseText('test:/master', masterPlaylist)
        .setResponseText('test:/video', videoInitial)
        .setResponseText('test:/audio', audioInitial)
        .setResponseValue('test:/init.mp4', initSegmentData)
        .setResponseValue('test:/v0.mp4', segmentData)
        .setResponseValue('test:/v1.mp4', segmentData)
        .setResponseValue('test:/v2.mp4', segmentData)
        .setResponseValue('test:/v3.mp4', segmentData)
        .setResponseValue('test:/v4.mp4', segmentData)
        .setResponseValue('test:/v5.mp4', segmentData)
        .setResponseValue('test:/v6.mp4', segmentData)
        .setResponseValue('test:/a0.mp4', segmentData)
        .setResponseValue('test:/a1.mp4', segmentData)
        .setResponseValue('test:/a2.mp4', segmentData)
        .setResponseValue('test:/a3.mp4', segmentData)
        .setResponseValue('test:/a4.mp4', segmentData)
        .setResponseValue('test:/a5.mp4', segmentData)
        .setResponseValue('test:/a6.mp4', segmentData);

    const manifest =
        await parser.start('test:/master', playerInterface);

    const actualVideo = manifest.variants[0].video;
    const actualAudio = manifest.variants[0].audio;
    await actualVideo.createSegmentIndex();
    await actualAudio.createSegmentIndex();
    goog.asserts.assert(actualVideo.segmentIndex != null, 'Null segmentIndex!');
    goog.asserts.assert(actualAudio.segmentIndex != null, 'Null segmentIndex!');

    // Initial: disc boundary at seg 2 should align
    const videoRefs0 = Array.from(actualVideo.segmentIndex);
    const audioRefs0 = Array.from(actualAudio.segmentIndex);
    expect(Math.abs(videoRefs0[2].startTime - audioRefs0[2].startTime))
        .toBeLessThan(0.001);

    // Update 1: window slides, starts inside disc 0
    fakeNetEngine
        .setResponseText('test:/video', videoUpdate1)
        .setResponseText('test:/audio', audioUpdate1);
    await delayForUpdatePeriod();

    const videoRefs1 = Array.from(actualVideo.segmentIndex);
    const audioRefs1 = Array.from(actualAudio.segmentIndex);
    for (let i = 0; i < videoRefs1.length; i++) {
      const vRef = videoRefs1[i];
      const aRef = audioRefs1[i];
      if (i === 0 || videoRefs1[i - 1].discontinuitySequence !==
          vRef.discontinuitySequence) {
        expect(Math.abs(vRef.startTime - aRef.startTime))
            .toBeLessThan(0.001);
      }
    }

    // Update 2: window slides INTO disc 1 (non-zero offset block)
    // This is where double-application could occur via
    // mediaSequenceToStartTime + audioDiscontinuityOffsets_
    fakeNetEngine
        .setResponseText('test:/video', videoUpdate2)
        .setResponseText('test:/audio', audioUpdate2);
    await delayForUpdatePeriod();

    const videoRefs2 = Array.from(actualVideo.segmentIndex);
    const audioRefs2 = Array.from(actualAudio.segmentIndex);

    // All disc boundaries should still align after multiple updates
    for (let i = 0; i < videoRefs2.length; i++) {
      const vRef = videoRefs2[i];
      const aRef = audioRefs2[i];
      if (i === 0 || videoRefs2[i - 1].discontinuitySequence !==
          vRef.discontinuitySequence) {
        expect(Math.abs(vRef.startTime - aRef.startTime))
            .toBeLessThan(0.001);
      }
    }

    // Seg 3 startTime should be correct (not double-offset)
    // Video seg 3 starts at 15s, audio seg 3 should be within 1ms
    const vSeg3 = videoRefs2.find((r) => r.getUris()[0] === 'test:/v3.mp4');
    const aSeg3 = audioRefs2.find((r) => r.getUris()[0] === 'test:/a3.mp4');
    if (vSeg3 && aSeg3) {
      expect(Math.abs(vSeg3.startTime - aSeg3.startTime))
          .toBeLessThan(0.001);
    }
  });

  it('prunes stale disc offsets during live window eviction', async () => {
    config.hls.ignoreManifestProgramDateTime = true;
    parser.configure(config);

    const masterPlaylist = [
      '#EXTM3U\n',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",LANGUAGE="eng",',
      'URI="audio"\n',
      '#EXT-X-STREAM-INF:BANDWIDTH=200,CODECS="avc1,mp4a",',
      'RESOLUTION=960x540,FRAME-RATE=60,AUDIO="aud1"\n',
      'video\n',
    ].join('');

    // Initial: v0-v5 (5s), a0-a5 (5.01s), disc at seg 2 and seg 4
    // 3 disc blocks: block 0 (0-1), block 1 (2-3), block 2 (4-5)
    const videoInitial = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:6\n',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
      '#EXT-X-MEDIA-SEQUENCE:0\n',
      '#EXT-X-DISCONTINUITY-SEQUENCE:0\n',
      '#EXTINF:5,\n',
      'v0.mp4\n',
      '#EXTINF:5,\n',
      'v1.mp4\n',
      '#EXT-X-DISCONTINUITY\n',
      '#EXTINF:5,\n',
      'v2.mp4\n',
      '#EXTINF:5,\n',
      'v3.mp4\n',
      '#EXT-X-DISCONTINUITY\n',
      '#EXTINF:5,\n',
      'v4.mp4\n',
      '#EXTINF:5,\n',
      'v5.mp4\n',
    ].join('');

    const audioInitial = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:6\n',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
      '#EXT-X-MEDIA-SEQUENCE:0\n',
      '#EXT-X-DISCONTINUITY-SEQUENCE:0\n',
      '#EXTINF:5.01,\n',
      'a0.mp4\n',
      '#EXTINF:5.01,\n',
      'a1.mp4\n',
      '#EXT-X-DISCONTINUITY\n',
      '#EXTINF:5.01,\n',
      'a2.mp4\n',
      '#EXTINF:5.01,\n',
      'a3.mp4\n',
      '#EXT-X-DISCONTINUITY\n',
      '#EXTINF:5.01,\n',
      'a4.mp4\n',
      '#EXTINF:5.01,\n',
      'a5.mp4\n',
    ].join('');

    // Update: window slides past disc 0 AND disc 1 boundary
    // disc-seq 2, refs 4-7, only disc 2 block remains
    const videoUpdated = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:6\n',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
      '#EXT-X-MEDIA-SEQUENCE:4\n',
      '#EXT-X-DISCONTINUITY-SEQUENCE:2\n',
      '#EXTINF:5,\n',
      'v4.mp4\n',
      '#EXTINF:5,\n',
      'v5.mp4\n',
      '#EXTINF:5,\n',
      'v6.mp4\n',
      '#EXTINF:5,\n',
      'v7.mp4\n',
    ].join('');

    const audioUpdated = [
      '#EXTM3U\n',
      '#EXT-X-TARGETDURATION:6\n',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
      '#EXT-X-MEDIA-SEQUENCE:4\n',
      '#EXT-X-DISCONTINUITY-SEQUENCE:2\n',
      '#EXTINF:5.01,\n',
      'a4.mp4\n',
      '#EXTINF:5.01,\n',
      'a5.mp4\n',
      '#EXTINF:5.01,\n',
      'a6.mp4\n',
      '#EXTINF:5.01,\n',
      'a7.mp4\n',
    ].join('');

    fakeNetEngine
        .setResponseText('test:/master', masterPlaylist)
        .setResponseText('test:/video', videoInitial)
        .setResponseText('test:/audio', audioInitial)
        .setResponseValue('test:/init.mp4', initSegmentData)
        .setResponseValue('test:/v0.mp4', segmentData)
        .setResponseValue('test:/v1.mp4', segmentData)
        .setResponseValue('test:/v2.mp4', segmentData)
        .setResponseValue('test:/v3.mp4', segmentData)
        .setResponseValue('test:/v4.mp4', segmentData)
        .setResponseValue('test:/v5.mp4', segmentData)
        .setResponseValue('test:/v6.mp4', segmentData)
        .setResponseValue('test:/v7.mp4', segmentData)
        .setResponseValue('test:/a0.mp4', segmentData)
        .setResponseValue('test:/a1.mp4', segmentData)
        .setResponseValue('test:/a2.mp4', segmentData)
        .setResponseValue('test:/a3.mp4', segmentData)
        .setResponseValue('test:/a4.mp4', segmentData)
        .setResponseValue('test:/a5.mp4', segmentData)
        .setResponseValue('test:/a6.mp4', segmentData)
        .setResponseValue('test:/a7.mp4', segmentData);

    const manifest =
        await parser.start('test:/master', playerInterface);

    const actualVideo = manifest.variants[0].video;
    const actualAudio = manifest.variants[0].audio;
    await actualVideo.createSegmentIndex();
    await actualAudio.createSegmentIndex();
    goog.asserts.assert(actualVideo.segmentIndex != null, 'Null segmentIndex!');
    goog.asserts.assert(actualAudio.segmentIndex != null, 'Null segmentIndex!');

    // Initial: both disc boundaries should align
    const videoRefs = Array.from(actualVideo.segmentIndex);
    const audioRefs = Array.from(actualAudio.segmentIndex);
    // Block 1 boundary at seg 2
    expect(Math.abs(videoRefs[2].startTime - audioRefs[2].startTime))
        .toBeLessThan(0.001);
    // Block 2 boundary at seg 4
    expect(Math.abs(videoRefs[4].startTime - audioRefs[4].startTime))
        .toBeLessThan(0.001);

    // Update: window slides past disc 0 and disc 1, only disc 2 remains
    fakeNetEngine
        .setResponseText('test:/video', videoUpdated)
        .setResponseText('test:/audio', audioUpdated);
    await delayForUpdatePeriod();

    const videoRefsAfter = Array.from(actualVideo.segmentIndex);
    const audioRefsAfter = Array.from(actualAudio.segmentIndex);

    // Disc 2 boundary alignment should still hold after eviction
    for (let i = 0; i < videoRefsAfter.length; i++) {
      const vRef = videoRefsAfter[i];
      const aRef = audioRefsAfter[i];
      if (i === 0 || videoRefsAfter[i - 1].discontinuitySequence !==
          vRef.discontinuitySequence) {
        expect(Math.abs(vRef.startTime - aRef.startTime))
            .toBeLessThan(0.001);
      }
    }

    // Segments within the remaining disc 2 block should chain correctly
    for (let i = 1; i < audioRefsAfter.length; i++) {
      if (audioRefsAfter[i].discontinuitySequence ===
          audioRefsAfter[i - 1].discontinuitySequence) {
        expect(audioRefsAfter[i].startTime)
            .toBeCloseTo(audioRefsAfter[i - 1].endTime, 5);
      }
    }
  });

  it('lazy-loaded live audio keeps first segment inside corrected disc block',
      async () => {
        config.hls.ignoreManifestProgramDateTime = true;
        parser.configure(config);

        const masterPlaylist = [
          '#EXTM3U\n',
          '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",LANGUAGE="eng",',
          'URI="audio_eng"\n',
          '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",LANGUAGE="spa",',
          'URI="audio_spa"\n',
          '#EXT-X-STREAM-INF:BANDWIDTH=200,CODECS="avc1,mp4a",',
          'RESOLUTION=960x540,FRAME-RATE=60,AUDIO="aud1"\n',
          'video\n',
        ].join('');

        // Initial: two blocks with a discontinuity boundary at seg 2.
        const videoInitial = [
          '#EXTM3U\n',
          '#EXT-X-TARGETDURATION:6\n',
          '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
          '#EXT-X-MEDIA-SEQUENCE:0\n',
          '#EXT-X-DISCONTINUITY-SEQUENCE:0\n',
          '#EXTINF:5,\n',
          'v0.mp4\n',
          '#EXTINF:5,\n',
          'v1.mp4\n',
          '#EXT-X-DISCONTINUITY\n',
          '#EXTINF:5,\n',
          'v2.mp4\n',
          '#EXTINF:5,\n',
          'v3.mp4\n',
        ].join('');

        const audioEngInitial = [
          '#EXTM3U\n',
          '#EXT-X-TARGETDURATION:6\n',
          '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
          '#EXT-X-MEDIA-SEQUENCE:0\n',
          '#EXT-X-DISCONTINUITY-SEQUENCE:0\n',
          '#EXTINF:5.01,\n',
          'a0.mp4\n',
          '#EXTINF:5.01,\n',
          'a1.mp4\n',
          '#EXT-X-DISCONTINUITY\n',
          '#EXTINF:5.01,\n',
          'a2.mp4\n',
          '#EXTINF:5.01,\n',
          'a3.mp4\n',
        ].join('');

        const audioSpaInitial = [
          '#EXTM3U\n',
          '#EXT-X-TARGETDURATION:6\n',
          '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
          '#EXT-X-MEDIA-SEQUENCE:0\n',
          '#EXT-X-DISCONTINUITY-SEQUENCE:0\n',
          '#EXTINF:5.02,\n',
          's0.mp4\n',
          '#EXTINF:5.02,\n',
          's1.mp4\n',
          '#EXT-X-DISCONTINUITY\n',
          '#EXTINF:5.02,\n',
          's2.mp4\n',
          '#EXTINF:5.02,\n',
          's3.mp4\n',
        ].join('');

        // Live update: window starts inside disc-seq 1 (no disc tag in body).
        const videoUpdated = [
          '#EXTM3U\n',
          '#EXT-X-TARGETDURATION:6\n',
          '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
          '#EXT-X-MEDIA-SEQUENCE:3\n',
          '#EXT-X-DISCONTINUITY-SEQUENCE:1\n',
          '#EXTINF:5,\n',
          'v3.mp4\n',
          '#EXTINF:5,\n',
          'v4.mp4\n',
          '#EXTINF:5,\n',
          'v5.mp4\n',
          '#EXTINF:5,\n',
          'v6.mp4\n',
        ].join('');

        const audioEngUpdated = [
          '#EXTM3U\n',
          '#EXT-X-TARGETDURATION:6\n',
          '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
          '#EXT-X-MEDIA-SEQUENCE:3\n',
          '#EXT-X-DISCONTINUITY-SEQUENCE:1\n',
          '#EXTINF:5.01,\n',
          'a3.mp4\n',
          '#EXTINF:5.01,\n',
          'a4.mp4\n',
          '#EXTINF:5.01,\n',
          'a5.mp4\n',
          '#EXTINF:5.01,\n',
          'a6.mp4\n',
        ].join('');

        const audioSpaUpdated = [
          '#EXTM3U\n',
          '#EXT-X-TARGETDURATION:6\n',
          '#EXT-X-MAP:URI="init.mp4",BYTERANGE="616@0"\n',
          '#EXT-X-MEDIA-SEQUENCE:3\n',
          '#EXT-X-DISCONTINUITY-SEQUENCE:1\n',
          '#EXTINF:5.02,\n',
          's3.mp4\n',
          '#EXTINF:5.02,\n',
          's4.mp4\n',
          '#EXTINF:5.02,\n',
          's5.mp4\n',
          '#EXTINF:5.02,\n',
          's6.mp4\n',
        ].join('');

        fakeNetEngine
            .setResponseText('test:/master', masterPlaylist)
            .setResponseText('test:/video', videoInitial)
            .setResponseText('test:/audio_eng', audioEngInitial)
            .setResponseText('test:/audio_spa', audioSpaInitial)
            .setResponseValue('test:/init.mp4', initSegmentData)
            .setResponseValue('test:/v0.mp4', segmentData)
            .setResponseValue('test:/v1.mp4', segmentData)
            .setResponseValue('test:/v2.mp4', segmentData)
            .setResponseValue('test:/v3.mp4', segmentData)
            .setResponseValue('test:/v4.mp4', segmentData)
            .setResponseValue('test:/v5.mp4', segmentData)
            .setResponseValue('test:/v6.mp4', segmentData)
            .setResponseValue('test:/a0.mp4', segmentData)
            .setResponseValue('test:/a1.mp4', segmentData)
            .setResponseValue('test:/a2.mp4', segmentData)
            .setResponseValue('test:/a3.mp4', segmentData)
            .setResponseValue('test:/a4.mp4', segmentData)
            .setResponseValue('test:/a5.mp4', segmentData)
            .setResponseValue('test:/a6.mp4', segmentData)
            .setResponseValue('test:/s0.mp4', segmentData)
            .setResponseValue('test:/s1.mp4', segmentData)
            .setResponseValue('test:/s2.mp4', segmentData)
            .setResponseValue('test:/s3.mp4', segmentData)
            .setResponseValue('test:/s4.mp4', segmentData)
            .setResponseValue('test:/s5.mp4', segmentData)
            .setResponseValue('test:/s6.mp4', segmentData);

        const manifest =
            await parser.start('test:/master', playerInterface);

        const actualVideo = manifest.variants[0].video;
        const audioEn = manifest.variants[0].audio;
        const audioEs = manifest.variants[1].audio;
        await actualVideo.createSegmentIndex();
        await audioEn.createSegmentIndex();
        goog.asserts.assert(
            actualVideo.segmentIndex != null, 'Null segmentIndex!');
        goog.asserts.assert(audioEn.segmentIndex != null, 'Null segmentIndex!');

        // Move active streams forward into a window that starts inside disc 1.
        fakeNetEngine
            .setResponseText('test:/video', videoUpdated)
            .setResponseText('test:/audio_eng', audioEngUpdated)
            .setResponseText('test:/audio_spa', audioSpaUpdated);
        await delayForUpdatePeriod();

        // Lazy-load alternate audio after the update.
        await audioEs.createSegmentIndex();
        goog.asserts.assert(audioEs.segmentIndex != null, 'Null segmentIndex!');
        const spaRefs = Array.from(audioEs.segmentIndex);
        expect(spaRefs.length).toBeGreaterThan(0);
        expect(spaRefs[0].getUris()[0]).toBe('test:/s3.mp4');

        // Ensure first segment in the corrected block is aligned with video.
        const videoRefs = Array.from(actualVideo.segmentIndex);
        const videoS3 = videoRefs.find(
            (r) => r.getUris()[0] === 'test:/v3.mp4');
        goog.asserts.assert(videoS3, 'Missing v3 segment');
        expect(Math.abs(videoS3.startTime - spaRefs[0].startTime))
            .toBeLessThan(0.001);
      });
});  // describe('HlsParser live')
