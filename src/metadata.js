'use strict';

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');

const VIDEO_EXTENSIONS = new Set([
  'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm',
  'm4v', 'mpg', 'mpeg', '3gp'
]);

const PHOTO_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'tif',
  'heic', 'webp', 'raw', 'arw', 'cr2', 'nef'
]);

function getMediaType(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (PHOTO_EXTENSIONS.has(ext)) return 'photo';
  return null;
}

function extractVideoMetadata(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);

      const videoStream = (data.streams || []).find(s => s.codec_type === 'video');
      const audioStream = (data.streams || []).find(s => s.codec_type === 'audio');
      const format = data.format || {};

      const duration = parseFloat(format.duration) || 0;
      const bitrate = parseInt(format.bit_rate, 10) || 0;
      const size = parseInt(format.size, 10) || 0;

      let createdAt = null;
      if (format.tags) {
        createdAt =
          format.tags.creation_time ||
          format.tags.date ||
          format.tags.DATE ||
          null;
      }

      resolve({
        duration,
        width: videoStream ? videoStream.width : null,
        height: videoStream ? videoStream.height : null,
        codec: videoStream ? videoStream.codec_name : null,
        format: format.format_name || null,
        bitrate,
        size,
        created_at: createdAt,
        audio_codec: audioStream ? audioStream.codec_name : null,
        raw: data
      });
    });
  });
}

async function extractPhotoMetadata(filePath) {
  let exifr;
  try {
    exifr = require('exifr');
  } catch {
    return { size: null, created_at: null, latitude: null, longitude: null, raw: {} };
  }

  try {
    const data = await exifr.parse(filePath, {
      tiff: true,
      xmp: true,
      icc: false,
      iptc: true,
      gps: true,
      pick: [
        'DateTimeOriginal', 'CreateDate', 'ModifyDate',
        'GPSLatitude', 'GPSLongitude', 'GPSAltitude',
        'Make', 'Model', 'ExposureTime', 'FNumber',
        'ISO', 'FocalLength', 'ImageWidth', 'ImageHeight',
        'PixelXDimension', 'PixelYDimension',
        'Orientation', 'Software', 'Artist', 'Copyright',
        'ImageDescription', 'UserComment', 'Location',
        'City', 'State', 'Country', 'CountryCode'
      ]
    }) || {};

    const width = data.ImageWidth || data.PixelXDimension || null;
    const height = data.ImageHeight || data.PixelYDimension || null;
    const createdAt = data.DateTimeOriginal || data.CreateDate || null;
    const latitude = data.GPSLatitude || null;
    const longitude = data.GPSLongitude || null;

    let locationStr = null;
    if (data.City || data.State || data.Country) {
      locationStr = [data.City, data.State, data.Country]
        .filter(Boolean)
        .join(', ');
    }

    return {
      width,
      height,
      created_at: createdAt ? createdAt.toISOString ? createdAt.toISOString() : String(createdAt) : null,
      latitude,
      longitude,
      location: locationStr,
      make: data.Make || null,
      model: data.Model || null,
      raw: data
    };
  } catch (err) {
    return { size: null, created_at: null, latitude: null, longitude: null, raw: {} };
  }
}

module.exports = { getMediaType, extractVideoMetadata, extractPhotoMetadata, VIDEO_EXTENSIONS, PHOTO_EXTENSIONS };
