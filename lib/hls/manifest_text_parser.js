/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('shaka.hls.ManifestTextParser');

goog.require('shaka.hls.Attribute');
goog.require('shaka.hls.Playlist');
goog.require('shaka.hls.PlaylistType');
goog.require('shaka.hls.Segment');
goog.require('shaka.hls.Tag');
goog.require('shaka.hls.Utils');
goog.require('shaka.util.Error');
goog.require('shaka.util.StringUtils');

goog.requireType('shaka.hls.SegmentComputed');
goog.requireType('shaka.hls.SegmentsComputed');
goog.requireType('shaka.hls.PlaylistComputed');
goog.require('shaka.util.TextParser');


/**
 * HlS manifest text parser.
 */
shaka.hls.ManifestTextParser = class {
  constructor() {
    /** @private {number} */
    this.globalId_ = 0;
  }

  /**
   * @param {BufferSource} data
   * @return {!shaka.hls.Playlist}
   */
  parsePlaylist(data) {
    // Get the input as a string.  Normalize newlines to \n.
    let str = shaka.util.StringUtils.fromUTF8(data);
    str = str.replace(/\r\n|\r(?=[^\n]|$)/gm, '\n').trim();

    const lines = str.split(/\n+/m);

    if (!shaka.hls.ManifestTextParser.STATIC_PATTERNS.header.test(lines[0])) {
      throw new shaka.util.Error(
          shaka.util.Error.Severity.CRITICAL,
          shaka.util.Error.Category.MANIFEST,
          shaka.util.Error.Code.HLS_PLAYLIST_HEADER_MISSING);
    }

    // Single-pass state machine for parsing
    let playlistType = shaka.hls.PlaylistType.MASTER;
    let typeDetected = false;
    const tags = [];
    const tagIndex = this.createDefaultTagIndex_();
    let skip = true;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const next = lines[i + 1];
      // Skip comments
      if (shaka.hls.Utils.isComment(line) || skip) {
        skip = false;
        continue;
      }

      const tag = this.parseTag_(line);

      // Detect playlist type on first relevant tag
      if (!typeDetected) {
        if (shaka.hls.ManifestTextParser.MEDIA_PLAYLIST_TAGS.has(tag.name)) {
          playlistType = shaka.hls.PlaylistType.MEDIA;
          typeDetected = true;
        } else if (tag.name == 'EXT-X-STREAM-INF' ||
                   tag.name == 'EXT-X-MEDIA') {
          // Master playlist detected, keep as MASTER
          typeDetected = true;
        } else if (shaka.hls.ManifestTextParser.SEGMENT_TAGS.has(tag.name)) {
          // Segment tags also indicate MEDIA playlist
          playlistType = shaka.hls.PlaylistType.MEDIA;
          typeDetected = true;
        }
      }

      // Transition to segment parsing
      if (shaka.hls.ManifestTextParser.SEGMENT_TAGS.has(tag.name)) {
        if (playlistType != shaka.hls.PlaylistType.MEDIA) {
          // Only media playlists should contain segment tags
          throw new shaka.util.Error(
              shaka.util.Error.Severity.CRITICAL,
              shaka.util.Error.Category.MANIFEST,
              shaka.util.Error.Code.HLS_INVALID_PLAYLIST_HIERARCHY);
        }

        const {segments, analysis: segmentAnalysis} =
          this.parseSegments_(lines, i, tags, tagIndex);

        return new shaka.hls.Playlist(playlistType, tags,
            {playlist: tagIndex, segments: segmentAnalysis}, segments);
      }

      tags.push(tag);
      this.updateTagIndexForTag_(tagIndex, tag);

      // An EXT-X-STREAM-INF tag is followed by a URI of a media playlist.
      // Add the URI to the tag object.
      if (tag.name == 'EXT-X-STREAM-INF') {
        const tagUri = new shaka.hls.Attribute('URI', next);
        tag.addAttribute(tagUri);
        skip = true;
      }
    }

    return new shaka.hls.Playlist(playlistType, tags,
        {playlist: tagIndex, segments: this.createDefaultSegmentsComputed_()},
        []);
  }

  /**
   * Parses an array of strings into an array of HLS Segment objects.
   *
   * @param {!Array<string>} lines
   * @param {number} startIndex
   * @param {!Array<!shaka.hls.Tag>} playlistTags
   * @param {!shaka.hls.PlaylistComputed} tagIndex
   * @return {{
   *  segments: !Array<shaka.hls.Segment>,
   *  analysis: !shaka.hls.SegmentsComputed
   * }}
   * @private
   */
  parseSegments_(lines, startIndex, playlistTags, tagIndex) {
    // Pre-allocate segments array for better performance with large playlists
    const remainingLines = lines.length - startIndex;
    const estimatedSegments = Math.max(100, Math.floor(remainingLines / 2));
    /** @type {!Array<shaka.hls.Segment>} */
    const segments = new Array(estimatedSegments);
    let segmentIndex = 0;
    /** @type {!Array<shaka.hls.Tag>} */
    let segmentTags = [];

    /** @type {!Array<shaka.hls.Tag>} */
    let partialSegmentTags = [];

    // The last parsed EXT-X-MAP tag.
    /** @type {?shaka.hls.Tag} */
    let currentMapTag = null;
    let gapCount = 0;
    let lastExtinfDuration = null;

    // Initialize computed data for current segment
    let computed = this.createDefaultComputed_();

    for (let lineIndex = startIndex; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      if (line.startsWith('#EXT')) {
        const tag = this.parseTag_(line);
        if (shaka.hls.ManifestTextParser.MEDIA_PLAYLIST_TAGS.has(tag.name)) {
          playlistTags.push(tag);
          this.updateTagIndexForTag_(tagIndex, tag);
        } else {
          // Mark the the EXT-X-MAP tag, and add it to the segment tags
          // following it later.
          if (tag.name == 'EXT-X-MAP') {
            currentMapTag = tag;
          } else if (tag.name == 'EXT-X-PART') {
            partialSegmentTags.push(tag);
          } else if (tag.name == 'EXT-X-PRELOAD-HINT') {
            if (tag.getAttributeValue('TYPE') == 'PART') {
              partialSegmentTags.push(tag);
            } else if (tag.getAttributeValue('TYPE') == 'MAP') {
              // Rename the Preload Hint tag to be a Map tag.
              tag.setName('EXT-X-MAP');
              currentMapTag = tag;
            }
          } else {
            segmentTags.push(tag);
          }

          // Update computed data incrementally for all tags
          this.updateComputedForTag_(computed, tag);
        }
      } else if (shaka.hls.Utils.isComment(line)) {
        // Skip comments.
      } else {
        const verbatimSegmentUri = line.trim();
        // Attach the last parsed EXT-X-MAP tag to the segment.
        if (currentMapTag) {
          segmentTags.push(currentMapTag);
        }

        if (computed.extinf) {
          lastExtinfDuration = computed.extinfDuration;
        }
        if (computed.gap) {
          gapCount++;
        }

        // Ensure computed inherits currentMapTag if no MAP tag was
        // processed for this segment
        if (!computed.map && currentMapTag) {
          computed.map = currentMapTag;
          computed.mapId = currentMapTag.id;
        }

        // The URI appears after all of the tags describing the segment.
        const segment = new shaka.hls.Segment(
            verbatimSegmentUri, segmentTags, computed, partialSegmentTags);
        if (segmentIndex < segments.length) {
          segments[segmentIndex++] = segment;
        } else {
          segments.push(segment);
          segmentIndex++;
        }
        segmentTags = [];
        partialSegmentTags = [];
        computed = this.createDefaultComputed_(); // Reset for next segment
      }
    }
    // After all the partial segments of a regular segment is published,
    // a EXTINF tag and Uri for a regular segment containing the same media
    // content will get published at last.
    // If no EXTINF tag follows the list of partial segment tags at the end,
    // create a segment to wrap the partial segment tags.
    if (partialSegmentTags.length) {
      if (currentMapTag) {
        segmentTags.push(currentMapTag);
      }

      // For final partial segments, we need to process tags
      // incrementally since they're outside main loop
      const computed = this.createDefaultComputed_();
      for (const tag of segmentTags) {
        this.updateComputedForTag_(computed, tag);
      }


      const segment = new shaka.hls.Segment('', segmentTags,
          computed, partialSegmentTags);
      if (segmentIndex < segments.length) {
        segments[segmentIndex++] = segment;
      } else {
        segments.push(segment);
        segmentIndex++;
      }
    }

    const analysis = {
      count: segmentIndex,
      gapCount: gapCount,
      lastExtinfDuration: lastExtinfDuration,
    };

    // Trim pre-allocated array to actual size
    const trimmedSegments = segmentIndex < segments.length ?
        segments.slice(0, segmentIndex) : segments;

    return {segments: trimmedSegments, analysis: analysis};
  }

  /**
   * Creates default computed data structure for a new segment.
   * @return {!shaka.hls.SegmentComputed} Default computed data structure
   * @private
   */
  createDefaultComputed_() {
    return {
      extinf: null,
      extinfDuration: 0,
      map: null,
      mapId: null,
      gap: null,
      byterange: null,
      discontinuity: null,
      keys: [],
      bitrate: 0,
      dateTime: null,
      tiles: null,
    };
  }

  /**
   * Creates default segments computed data structure.
   * @return {!shaka.hls.SegmentsComputed} Default segments computed data
   * @private
   */
  createDefaultSegmentsComputed_() {
    return {
      count: 0,
      gapCount: 0,
      lastExtinfDuration: null,
    };
  }

  /**
   * Update computed data incrementally for a single tag
   * @param {!shaka.hls.SegmentComputed} computed
   * @param {!shaka.hls.Tag} tag
   * @private
   */
  updateComputedForTag_(computed, tag) {
    switch (tag.name) {
      case 'EXTINF': {
        if (!computed.extinf) {
          computed.extinf = tag;
          // Pre-parse duration to avoid repeated parsing
          const duration = tag.value.split(',')[0];
          computed.extinfDuration = Number(duration);
        }
        break;
      }
      case 'EXT-X-MAP': {
        if (!computed.map) {
          computed.map = tag;
          computed.mapId = tag.id;
        }
        break;
      }
      case 'EXT-X-GAP': {
        if (!computed.gap) {
          computed.gap = tag;
        }
        break;
      }
      case 'EXT-X-BYTERANGE': {
        if (!computed.byterange) {
          computed.byterange = tag;
        }
        break;
      }
      case 'EXT-X-DISCONTINUITY': {
        if (!computed.discontinuity) {
          computed.discontinuity = tag;
        }
        break;
      }
      case 'EXT-X-KEY': {
        computed.keys.push(tag);
        break;
      }
      case 'EXT-X-PROGRAM-DATE-TIME': {
        if (!computed.dateTime) {
          computed.dateTime = tag;
        }
        break;
      }
      case 'EXT-X-TILES': {
        if (!computed.tiles) {
          computed.tiles = tag;
        }
        break;
      }
      case 'EXT-X-BITRATE': {
        if (!computed.bitrate) {
          computed.bitrate = Number(tag.value || 0);
        }
        break;
      }
    }
  }

  /**
   * Creates default playlist tag index structure.
   * @return {!shaka.hls.PlaylistComputed} Default tag index structure
   * @private
   */
  createDefaultTagIndex_() {
    return {
      // Pre-converted numeric values
      mediaSequence: 0,
      skippedSegments: 0,
      discontinuitySequence: -1,

      // Single-value tag references
      skipTag: null,
      endListTag: null,
      serverControlTag: null,
      playlistTypeTag: null,
      startTag: null,
      partInfTag: null,
      targetDurationTag: null,

      // Multi-value tag arrays
      variableTags: [],
      dateRangeTags: [],
      mediaTags: [],
      variantTags: [],
      imageTags: [],
      iFrameTags: [],
      sessionKeyTags: [],
      sessionDataTags: [],
      contentSteeringTags: [],
    };
  }

  /**
   * Updates playlist tag index incrementally for a single tag.
   * @param {!shaka.hls.PlaylistComputed} index The tag index to update
   * @param {!shaka.hls.Tag} tag The tag to process
   * @private
   */
  updateTagIndexForTag_(index, tag) {
    switch (tag.name) {
      case 'EXT-X-MEDIA-SEQUENCE':
        index.mediaSequence = Number(tag.value || 0);
        break;

      case 'EXT-X-SKIP': {
        index.skipTag = tag;
        const skipped = tag.getAttributeValue('SKIPPED-SEGMENTS');
        index.skippedSegments = skipped ? Number(skipped) : 0;
        break;
      }

      case 'EXT-X-DEFINE':
        index.variableTags.push(tag);
        break;

      case 'EXT-X-ENDLIST':
        if (!index.endListTag) {
          index.endListTag = tag;
        }
        break;

      case 'EXT-X-SERVER-CONTROL':
        if (!index.serverControlTag) {
          index.serverControlTag = tag;
        }
        break;

      case 'EXT-X-PLAYLIST-TYPE':
        if (!index.playlistTypeTag) {
          index.playlistTypeTag = tag;
        }
        break;

      case 'EXT-X-START':
        if (!index.startTag) {
          index.startTag = tag;
        }
        break;

      case 'EXT-X-PART-INF':
        if (!index.partInfTag) {
          index.partInfTag = tag;
        }
        break;

      case 'EXT-X-TARGETDURATION':
        if (!index.targetDurationTag) {
          index.targetDurationTag = tag;
        }
        break;

      case 'EXT-X-DATERANGE':
        index.dateRangeTags.push(tag);
        break;

      case 'EXT-X-DISCONTINUITY-SEQUENCE':
        index.discontinuitySequence = Number(tag.value || -1);
        break;

      case 'EXT-X-MEDIA':
        index.mediaTags.push(tag);
        break;

      case 'EXT-X-STREAM-INF':
        index.variantTags.push(tag);
        break;

      case 'EXT-X-IMAGE-STREAM-INF':
        index.imageTags.push(tag);
        break;

      case 'EXT-X-I-FRAME-STREAM-INF':
        index.iFrameTags.push(tag);
        break;

      case 'EXT-X-SESSION-KEY':
        index.sessionKeyTags.push(tag);
        break;

      case 'EXT-X-SESSION-DATA':
        index.sessionDataTags.push(tag);
        break;

      case 'EXT-X-CONTENT-STEERING':
        index.contentSteeringTags.push(tag);
        break;
    }
  }

  /**
   * Parses a string into an HLS Tag object while tracking what id to use next.
   *
   * @param {string} word
   * @return {!shaka.hls.Tag}
   * @private
   */
  parseTag_(word) {
    return shaka.hls.ManifestTextParser.parseTag(this.globalId_++, word);
  }

  /**
   * Parses a string into an HLS Tag object.
   *
   * @param {number} id
   * @param {string} word
   * @return {!shaka.hls.Tag}
   */
  static parseTag(id, word) {
    /* HLS tags start with '#EXT'. A tag can have a set of attributes
      (#EXT-<tagname>:<attribute list>) and/or a value (#EXT-<tagname>:<value>).
      An attribute's format is 'AttributeName=AttributeValue'.
      The parsing logic goes like this:
       1. Everything before ':' is a name (we ignore '#').
       2. Everything after ':' is a list of comma-separated items,
            2a. The first item might be a value, if it does not contain '='.
            2b. Otherwise, items are attributes.
       3. If there is no ":", it's a simple tag with no attributes and no value.
    */
    const blocks = word.match(
        shaka.hls.ManifestTextParser.STATIC_PATTERNS.tagBlocks);
    if (!blocks) {
      throw new shaka.util.Error(
          shaka.util.Error.Severity.CRITICAL,
          shaka.util.Error.Category.MANIFEST,
          shaka.util.Error.Code.INVALID_HLS_TAG,
          word);
    }
    const name = blocks[1];
    const data = blocks[2];
    const attributes = [];
    let value;

    if (data) {
      const parser = new shaka.util.TextParser(data);
      let blockAttrs;

      // re-using global regex: reset lastIndex
      shaka.hls.ManifestTextParser.STATIC_PATTERNS.valueRegex.lastIndex = 0;
      const blockValue = parser.readRegex(
          shaka.hls.ManifestTextParser.STATIC_PATTERNS.valueRegex);

      if (blockValue) {
        value = blockValue[1];
      }

      // re-using global regex: reset lastIndex
      shaka.hls.ManifestTextParser.STATIC_PATTERNS.attributeRegex.lastIndex = 0;
      blockAttrs = parser.readRegex(
          shaka.hls.ManifestTextParser.STATIC_PATTERNS.attributeRegex);
      while (blockAttrs) {
        const attrName = blockAttrs[1];
        const attrValue = blockAttrs[2] || blockAttrs[3];
        const attribute = new shaka.hls.Attribute(attrName, attrValue);
        attributes.push(attribute);
        parser.skipWhitespace();
        blockAttrs = parser.readRegex(
            shaka.hls.ManifestTextParser.STATIC_PATTERNS.attributeRegex);
      }
    }

    return new shaka.hls.Tag(id, name, attributes, value);
  }
};

/**
 * Static pre-compiled regex patterns for maximum performance.
 * Shared across all parser instances.
 * Pre-compiled patterns eliminate repeated regex compilation during parsing.
 * @const {{tagBlocks: !RegExp, valueRegex: !RegExp, attributeRegex: !RegExp,
 *   header: !RegExp}}
 */
shaka.hls.ManifestTextParser.STATIC_PATTERNS = {
  tagBlocks: /^#(EXT[^:]*)(?::(.*))?$/,
  header: /^#EXTM3U($|[ \t\n])/m,

  // Regex: any number of non-equals-sign characters at the beginning
  // terminated by comma or end of line
  valueRegex: /^([^,=]+)(?:,|$)/g,

  // Regex:
  // 1. Key name ([1])
  // 2. Equals sign
  // 3. Either:
  //   a. A quoted string (everything up to the next quote, [2])
  //   b. An unquoted string
  //    (everything up to the next comma or end of line, [3])
  // 4. Either:
  //   a. A comma
  //   b. End of line
  attributeRegex: /([^=]+)=(?:"([^"]*)"|([^",]*))(?:,|$)/g,
};


/**
 * HLS tags that only appear on Media Playlists.
 * Used to determine a playlist type.
 * O(1) lookup set for tag classification.
 *
 * @const {!Set<string>}
 */
shaka.hls.ManifestTextParser.MEDIA_PLAYLIST_TAGS = new Set([
  'EXT-X-TARGETDURATION',
  'EXT-X-MEDIA-SEQUENCE',
  'EXT-X-DISCONTINUITY-SEQUENCE',
  'EXT-X-PLAYLIST-TYPE',
  'EXT-X-I-FRAMES-ONLY',
  'EXT-X-ENDLIST',
  'EXT-X-SERVER-CONTROL',
  'EXT-X-SKIP',
  'EXT-X-PART-INF',
  'EXT-X-DATERANGE',
]);


/**
 * HLS tags that only appear on Segments in a Media Playlists.
 * Used to determine the start of the segments info.
 * O(1) lookup set for tag classification.
 *
 * @const {!Set<string>}
 */
shaka.hls.ManifestTextParser.SEGMENT_TAGS = new Set([
  'EXTINF',
  'EXT-X-BYTERANGE',
  'EXT-X-DISCONTINUITY',
  'EXT-X-PROGRAM-DATE-TIME',
  'EXT-X-KEY',
  'EXT-X-DATERANGE',
  'EXT-X-MAP',
  'EXT-X-GAP',
  'EXT-X-TILES',
]);
