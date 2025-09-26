/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('shaka.hls.Attribute');
goog.provide('shaka.hls.Playlist');
goog.provide('shaka.hls.PlaylistComputed');
goog.provide('shaka.hls.PlaylistComputedData');
goog.provide('shaka.hls.PlaylistType');
goog.provide('shaka.hls.Segment');
goog.provide('shaka.hls.SegmentComputed');
goog.provide('shaka.hls.SegmentsComputed');
goog.provide('shaka.hls.Tag');


/**
 * @typedef {{
 *   extinf: ?shaka.hls.Tag,
 *   extinfDuration: number,
 *   map: ?shaka.hls.Tag,
 *   mapId: ?number,
 *   gap: ?shaka.hls.Tag,
 *   byterange: ?shaka.hls.Tag,
 *   discontinuity: ?shaka.hls.Tag,
 *   keys: !Array<!shaka.hls.Tag>,
 *   bitrate: number,
 *   dateTime: ?shaka.hls.Tag,
 *   tiles: ?shaka.hls.Tag
 * }}
 *
 * Pre-computed analysis of segment tags for O(1) access to tag information
 *
 * Properties:
 * - extinf: EXT-INF tag containing duration and title information
 * - extinfDuration: Pre-parsed duration from EXTINF tag
 * - map: EXT-X-MAP tag for initialization segment reference
 * - mapId: Unique identifier for the map tag (for caching purposes)
 * - gap: EXT-X-GAP tag indicating missing segment data
 * - byterange: EXT-X-BYTERANGE tag for sub-range requests
 * - discontinuity: EXT-X-DISCONTINUITY tag marking timeline breaks
 * - keys: Array of EXT-X-KEY tags for encryption/DRM
 * - bitrate: Segment bitrate from EXT-X-BITRATE tag
 * - dateTime: EXT-X-PROGRAM-DATE-TIME tag for absolute timing
 * - tiles: EXT-X-TILES tag for tiled streaming
 */
shaka.hls.SegmentComputed;


/**
 * @typedef {{
 *   mediaSequence: number,
 *   skippedSegments: number,
 *   discontinuitySequence: number,
 *   skipTag: ?shaka.hls.Tag,
 *   endListTag: ?shaka.hls.Tag,
 *   serverControlTag: ?shaka.hls.Tag,
 *   playlistTypeTag: ?shaka.hls.Tag,
 *   startTag: ?shaka.hls.Tag,
 *   partInfTag: ?shaka.hls.Tag,
 *   targetDurationTag: ?shaka.hls.Tag,
 *   variableTags: !Array<!shaka.hls.Tag>,
 *   dateRangeTags: !Array<!shaka.hls.Tag>,
 *   mediaTags: !Array<!shaka.hls.Tag>,
 *   variantTags: !Array<!shaka.hls.Tag>,
 *   imageTags: !Array<!shaka.hls.Tag>,
 *   iFrameTags: !Array<!shaka.hls.Tag>,
 *   sessionKeyTags: !Array<!shaka.hls.Tag>,
 *   sessionDataTags: !Array<!shaka.hls.Tag>,
 *   contentSteeringTags: !Array<!shaka.hls.Tag>
 * }}
 *
 * Pre-indexed playlist-level tags and pre-converted numeric values for
 * immediate access without parsing.
 *
 */
shaka.hls.PlaylistComputed;


/**
 * @typedef {{
 *   count: number,
 *   gapCount: number,
 *   lastExtinfDuration: ?number
 * }}
 *
 * Aggregated segment analysis and playlist-level statistics computed
 * during single-pass parsing.
 */
shaka.hls.SegmentsComputed;


/**
 * @typedef {{
 *   playlist: shaka.hls.PlaylistComputed,
 *   segments: !shaka.hls.SegmentsComputed
 * }}
 *
 * Complete pre-computed data structure for O(1) tag lookups, eliminating
 * the need for repeated linear searches through playlist and segment tags.
 *
 * Structure breakdown:
 * - playlist: Contains pre-indexed playlist-level tags and pre-converted
 *   numeric values for immediate access without parsing
 * - segments: Contains per-segment tag analysis and playlist-level
 *   statistics computed during the single-pass parsing
 */
shaka.hls.PlaylistComputedData;

goog.require('goog.asserts');
goog.require('shaka.util.Error');


/**
 * HLS playlist class.
 */
shaka.hls.Playlist = class {
  /**
   * @param {!shaka.hls.PlaylistType} type
   * @param {!Array<shaka.hls.Tag>} tags
   * @param {!shaka.hls.PlaylistComputedData} computed
   * @param {?Array<shaka.hls.Segment>=} segments
   */
  constructor(type, tags, computed, segments) {
    /** @const {shaka.hls.PlaylistType} */
    this.type = type;

    /** @const {!Array<!shaka.hls.Tag>} */
    this.tags = tags;

    /** @const {?Array<!shaka.hls.Segment>} */
    this.segments = segments || null;

    /** @const {!shaka.hls.PlaylistComputedData} */
    this.computed = computed;
  }
};


/**
 * @enum {number}
 */
shaka.hls.PlaylistType = {
  MASTER: 0,
  MEDIA: 1,
};


/**
 * HLS tag class.
 */
shaka.hls.Tag = class {
  /**
   * @param {number} id
   * @param {string} name
   * @param {!Array<shaka.hls.Attribute>} attributes
   * @param {?string=} value
   */
  constructor(id, name, attributes, value = null) {
    /** @const {number} */
    this.id = id;

    /** @type {string} */
    this.name = name;

    /** @const {!Array<shaka.hls.Attribute>} */
    this.attributes = attributes;

    /** @const {?string} */
    this.value = value;
  }

  /**
   * Create the string representation of the tag.
   *
   * For the DRM system - the full tag needs to be passed down to the CDM.
   * There are two ways of doing this (1) save the original tag or (2) recreate
   * the tag.
   * As in some cases (like in tests) the tag never existed in string form, it
   * is far easier to recreate the tag from the parsed form.
   *
   * @param {?Set<string>=} attributesToSkip
   * @return {string}
   * @override
   */
  toString(attributesToSkip) {
    /**
     * @param {shaka.hls.Attribute} attr
     * @return {string}
     */
    const attrToStr = (attr) => {
      const isNumericAttr = !isNaN(Number(attr.value));
      const value = (isNumericAttr ? attr.value : '"' + attr.value + '"');
      return attr.name + '=' + value;
    };
    // A valid tag can only follow 1 of 4 patterns.
    //  1) <NAME>:<VALUE>
    //  2) <NAME>:<ATTRIBUTE LIST>
    //  3) <NAME>
    //  4) <NAME>:<VALUE>,<ATTRIBUTE_LIST>

    let tagStr = '#' + this.name;
    const appendages = this.attributes ? this.attributes.filter((attr) => {
      if (!attributesToSkip) {
        return true;
      }
      return !attributesToSkip.has(attr.name);
    }).map(attrToStr) : [];

    if (this.value) {
      appendages.unshift(this.value);
    }

    if (appendages.length > 0) {
      tagStr += ':' + appendages.join(',');
    }

    return tagStr;
  }

  /**
   * Create the string key of the tag.
   *
   * @param {boolean} keepAllAttributes
   * @return {string}
   */
  getTagKey(keepAllAttributes) {
    if (keepAllAttributes) {
      return this.toString();
    }
    const attributesToSkip = new Set()
        .add('AUDIO')
        .add('VIDEO')
        .add('SUBTITLES')
        .add('PATHWAY-ID')
        .add('GROUP-ID')
        .add('URI');
    return this.toString(attributesToSkip);
  }

  /**
   * Adds an attribute to an HLS Tag.
   *
   * @param {!shaka.hls.Attribute} attribute
   */
  addAttribute(attribute) {
    this.attributes.push(attribute);
  }


  /**
   * Gets the first attribute of the tag with a specified name.
   *
   * @param {string} name
   * @return {?shaka.hls.Attribute} attribute
   */
  getAttribute(name) {
    const attributes = this.attributes.filter((attr) => {
      return attr.name == name;
    });

    goog.asserts.assert(attributes.length < 2,
        'A tag should not have multiple attributes ' +
                        'with the same name!');

    if (attributes.length) {
      return attributes[0];
    } else {
      return null;
    }
  }

  /**
   * Gets the value of the first attribute of the tag with a specified name.
   * If not found, returns an optional default value.
   *
   * @param {string} name
   * @param {string=} defaultValue
   * @return {?string}
   */
  getAttributeValue(name, defaultValue) {
    const attribute = this.getAttribute(name);
    return attribute ? attribute.value : (defaultValue || null);
  }


  /**
   * Finds the attribute and returns its value.
   * Throws an error if attribute was not found.
   *
   * @param {string} name
   * @return {string}
   */
  getRequiredAttrValue(name) {
    const attribute = this.getAttribute(name);
    if (!attribute) {
      throw new shaka.util.Error(
          shaka.util.Error.Severity.CRITICAL,
          shaka.util.Error.Category.MANIFEST,
          shaka.util.Error.Code.HLS_REQUIRED_ATTRIBUTE_MISSING,
          name);
    }

    return attribute.value;
  }

  /**
   * Set the name of the tag. Used only for Preload hinted MAP tag.
   * @param {string} name
   */
  setName(name) {
    this.name = name;
  }
};


/**
 * HLS segment class.
 */
shaka.hls.Segment = class {
  /**
   * Creates an HLS segment object.
   *
   * @param {string} verbatimSegmentUri verbatim segment URI.
   * @param {!Array<shaka.hls.Tag>} tags
   * @param {!shaka.hls.SegmentComputed} computed Pre-computed segment tag
   *   analysis for O(1) access.
   * @param {!Array<shaka.hls.Tag>=} partialSegments
   */
  constructor(verbatimSegmentUri, tags, computed, partialSegments=[]) {
    /** @const {!Array<shaka.hls.Tag>} */
    this.tags = tags;

    /** @const {?string} */
    this.verbatimSegmentUri = verbatimSegmentUri;

    /** @type {!Array<shaka.hls.Tag>} */
    this.partialSegments = partialSegments;

    /** @const {!shaka.hls.SegmentComputed} */
    this.computed = computed;
  }
};


/**
 * HLS Attribute class.
 */
shaka.hls.Attribute = class {
  /**
   * Creates an HLS attribute object.
   *
   * @param {string} name
   * @param {string} value
   */
  constructor(name, value) {
    /** @const {string} */
    this.name = name;

    /** @const {string} */
    this.value = value;
  }
};
