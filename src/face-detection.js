'use strict';

const path = require('path');
const fs = require('fs');
const { getDb } = require('./db');

let faceapi = null;
let tf = null;
let modelsLoaded = false;

async function loadModels() {
  if (modelsLoaded) return true;

  try {
    tf = require('@tensorflow/tfjs-node');
    faceapi = require('@vladmandic/face-api');
  } catch {
    return false;
  }

  const DATA_DIR = process.env.DATA_DIR || '/data';
  const modelsDir = path.join(DATA_DIR, 'models');

  if (!fs.existsSync(modelsDir)) return false;

  try {
    await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelsDir);
    await faceapi.nets.faceLandmark68Net.loadFromDisk(modelsDir);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(modelsDir);
    modelsLoaded = true;
    return true;
  } catch {
    return false;
  }
}

async function detectFaces(imagePath) {
  const ready = await loadModels();
  if (!ready) return [];

  try {
    const canvas = require('canvas');
    const img = await canvas.loadImage(imagePath);
    const detections = await faceapi
      .detectAllFaces(img)
      .withFaceLandmarks()
      .withFaceDescriptors();

    return detections.map(d => ({
      bounds: {
        x: d.detection.box.x,
        y: d.detection.box.y,
        width: d.detection.box.width,
        height: d.detection.box.height
      },
      confidence: d.detection.score
    }));
  } catch {
    return [];
  }
}

async function detectFacesInMedia(mediaId, filePath, type) {
  const db = getDb();

  try {
    let imagePath = filePath;

    if (type === 'video') {
      // Use the existing thumbnail for face detection
      const DATA_DIR = process.env.DATA_DIR || '/data';
      const thumbPath = path.join(DATA_DIR, 'thumbnails', `${mediaId}.jpg`);
      if (!fs.existsSync(thumbPath)) return;
      imagePath = thumbPath;
    }

    const faces = await detectFaces(imagePath);
    if (!faces.length) return;

    const insert = db.prepare(
      'INSERT INTO faces (media_id, confidence, bounds) VALUES (?, ?, ?)'
    );
    const updateCount = db.prepare(
      'UPDATE media SET faces_detected = ? WHERE id = ?'
    );

    const insertMany = db.transaction(faceList => {
      for (const face of faceList) {
        insert.run(mediaId, face.confidence, JSON.stringify(face.bounds));
      }
      updateCount.run(faceList.length, mediaId);
    });

    insertMany(faces);
  } catch (err) {
    console.error(`[face-detection] Error processing ${filePath}:`, err.message);
  }
}

module.exports = { detectFaces, detectFacesInMedia };
