import type { PoseLandmark } from '@/types/pose';
import { POSE_LANDMARKS } from '@/types/pose';
import type { ClothingCategory, ClothingTransform, ClothingQuad, ClothingAnchorPoints } from '@/types/clothing';

const MIN_VISIBILITY = 0.5;
const PADDING_FACTOR = 1.5; // 50% padding around clothing for better coverage
const SIZE_MULTIPLIER = 1.3; // Additional scale multiplier to compensate for square crops

/**
 * Post-processes pose landmarks to estimate missing joints (e.g. if hips are cut off at bottom of screen)
 */
export function estimateMissingLandmarks(landmarks: PoseLandmark[]): PoseLandmark[] {
  if (!landmarks || landmarks.length < 33) return landmarks;

  // Make a copy of landmarks so we don't mutate the original state
  const processed = landmarks.map(lm => ({ ...lm }));

  const lShoulder = processed[POSE_LANDMARKS.LEFT_SHOULDER];
  const rShoulder = processed[POSE_LANDMARKS.RIGHT_SHOULDER];

  const shouldersVisible =
    lShoulder &&
    rShoulder &&
    lShoulder.visibility >= 0.5 &&
    rShoulder.visibility >= 0.5;

  if (shouldersVisible) {
    // 1. Estimate elbows if missing
    if (!processed[POSE_LANDMARKS.LEFT_ELBOW] || processed[POSE_LANDMARKS.LEFT_ELBOW].visibility < 0.5) {
      processed[POSE_LANDMARKS.LEFT_ELBOW] = {
        x: lShoulder.x - 0.05,
        y: lShoulder.y + 0.15,
        z: lShoulder.z,
        visibility: 0.8,
      };
    }
    if (!processed[POSE_LANDMARKS.RIGHT_ELBOW] || processed[POSE_LANDMARKS.RIGHT_ELBOW].visibility < 0.5) {
      processed[POSE_LANDMARKS.RIGHT_ELBOW] = {
        x: rShoulder.x + 0.05,
        y: rShoulder.y + 0.15,
        z: rShoulder.z,
        visibility: 0.8,
      };
    }

    // 2. Estimate hips if missing
    const shoulderWidth = Math.hypot(rShoulder.x - lShoulder.x, rShoulder.y - lShoulder.y);
    const torsoHeight = shoulderWidth * 1.5;

    const leftHipIndex = POSE_LANDMARKS.LEFT_HIP;
    const rightHipIndex = POSE_LANDMARKS.RIGHT_HIP;

    if (!processed[leftHipIndex] || processed[leftHipIndex].visibility < 0.5) {
      processed[leftHipIndex] = {
        x: lShoulder.x,
        y: lShoulder.y + torsoHeight,
        z: lShoulder.z,
        visibility: 0.8,
      };
    }

    if (!processed[rightHipIndex] || processed[rightHipIndex].visibility < 0.5) {
      processed[rightHipIndex] = {
        x: rShoulder.x,
        y: rShoulder.y + torsoHeight,
        z: rShoulder.z,
        visibility: 0.8,
      };
    }
  }

  // 3. Estimate knees and ankles for bottoms if hips are visible but leg joints are missing
  const lHip = processed[POSE_LANDMARKS.LEFT_HIP];
  const rHip = processed[POSE_LANDMARKS.RIGHT_HIP];
  const hipsVisible =
    lHip &&
    rHip &&
    lHip.visibility >= 0.5 &&
    rHip.visibility >= 0.5;

  if (hipsVisible) {
    const hipWidth = Math.hypot(rHip.x - lHip.x, rHip.y - lHip.y);
    const legLength = hipWidth * 2.5;

    if (!processed[POSE_LANDMARKS.LEFT_KNEE] || processed[POSE_LANDMARKS.LEFT_KNEE].visibility < 0.5) {
      processed[POSE_LANDMARKS.LEFT_KNEE] = {
        x: lHip.x,
        y: lHip.y + legLength * 0.5,
        z: lHip.z,
        visibility: 0.8,
      };
    }
    if (!processed[POSE_LANDMARKS.RIGHT_KNEE] || processed[POSE_LANDMARKS.RIGHT_KNEE].visibility < 0.5) {
      processed[POSE_LANDMARKS.RIGHT_KNEE] = {
        x: rHip.x,
        y: rHip.y + legLength * 0.5,
        z: rHip.z,
        visibility: 0.8,
      };
    }
    if (!processed[POSE_LANDMARKS.LEFT_ANKLE] || processed[POSE_LANDMARKS.LEFT_ANKLE].visibility < 0.5) {
      processed[POSE_LANDMARKS.LEFT_ANKLE] = {
        x: lHip.x,
        y: lHip.y + legLength,
        z: lHip.z,
        visibility: 0.8,
      };
    }
    if (!processed[POSE_LANDMARKS.RIGHT_ANKLE] || processed[POSE_LANDMARKS.RIGHT_ANKLE].visibility < 0.5) {
      processed[POSE_LANDMARKS.RIGHT_ANKLE] = {
        x: rHip.x,
        y: rHip.y + legLength,
        z: rHip.z,
        visibility: 0.8,
      };
    }
  }

  return processed;
}

interface PixelCoord {
  x: number;
  y: number;
}

/**
 * Convert normalized landmark coordinates to pixel coordinates
 */
export function landmarkToPixel(
  landmark: PoseLandmark,
  canvasWidth: number,
  canvasHeight: number,
  videoWidth?: number,
  videoHeight?: number
): PixelCoord {
  if (!videoWidth || !videoHeight) {
    return {
      x: landmark.x * canvasWidth,
      y: landmark.y * canvasHeight,
    };
  }

  const videoRatio = videoWidth / videoHeight;
  const canvasRatio = canvasWidth / canvasHeight;

  let x = landmark.x;
  let y = landmark.y;

  if (videoRatio > canvasRatio) {
    // Video is wider than canvas -> cropped on left and right
    const scale = canvasHeight / videoHeight;
    const renderedWidth = videoWidth * scale;
    const offsetX = (renderedWidth - canvasWidth) / 2;
    return {
      x: landmark.x * renderedWidth - offsetX,
      y: landmark.y * canvasHeight,
    };
  } else {
    // Video is taller than canvas -> cropped on top and bottom
    const scale = canvasWidth / videoWidth;
    const renderedHeight = videoHeight * scale;
    const offsetY = (renderedHeight - canvasHeight) / 2;
    return {
      x: landmark.x * canvasWidth,
      y: landmark.y * renderedHeight - offsetY,
    };
  }
}

/**
 * Calculate distance between two pixel coordinates
 */
function distance(a: PixelCoord, b: PixelCoord): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Get the landmark indices needed for a clothing category
 */
function getCategoryLandmarks(category: ClothingCategory): number[] {
  switch (category) {
    case 'tops':
      return [
        POSE_LANDMARKS.LEFT_SHOULDER,
        POSE_LANDMARKS.RIGHT_SHOULDER,
        POSE_LANDMARKS.LEFT_ELBOW,
        POSE_LANDMARKS.RIGHT_ELBOW,
        POSE_LANDMARKS.LEFT_HIP,
        POSE_LANDMARKS.RIGHT_HIP,
      ];
    case 'bottoms':
      return [
        POSE_LANDMARKS.LEFT_HIP,
        POSE_LANDMARKS.RIGHT_HIP,
        POSE_LANDMARKS.LEFT_KNEE,
        POSE_LANDMARKS.RIGHT_KNEE,
        POSE_LANDMARKS.LEFT_ANKLE,
        POSE_LANDMARKS.RIGHT_ANKLE,
      ];
  }
}

/**
 * Check if all required landmarks for a category are visible
 */
export function areLandmarksVisible(
  landmarks: PoseLandmark[],
  category: ClothingCategory
): boolean {
  const estimated = estimateMissingLandmarks(landmarks);
  const requiredIndices = getCategoryLandmarks(category);
  return requiredIndices.every((idx) => estimated[idx]?.visibility >= MIN_VISIBILITY);
}

/**
 * Calculate affine transform for tops (shirts, jackets, hoodies)
 * Uses 6-point anchor: shoulders + elbows + hips
 * Projects onto 4-corner rectangle: shoulders + hips
 */
function calculateTopTransform(
  landmarks: PoseLandmark[],
  canvasWidth: number,
  canvasHeight: number,
  videoWidth?: number,
  videoHeight?: number
): ClothingTransform | null {
  // Check visibility of all required landmarks
  if (!areLandmarksVisible(landmarks, 'tops')) {
    return null;
  }

  // Get landmarks
  const lShoulder = landmarks[POSE_LANDMARKS.LEFT_SHOULDER];
  const rShoulder = landmarks[POSE_LANDMARKS.RIGHT_SHOULDER];
  const lHip = landmarks[POSE_LANDMARKS.LEFT_HIP];
  const rHip = landmarks[POSE_LANDMARKS.RIGHT_HIP];

  // Convert to pixels
  const tlPx = landmarkToPixel(lShoulder, canvasWidth, canvasHeight, videoWidth, videoHeight);
  const trPx = landmarkToPixel(rShoulder, canvasWidth, canvasHeight, videoWidth, videoHeight);
  const blPx = landmarkToPixel(lHip, canvasWidth, canvasHeight, videoWidth, videoHeight);
  const brPx = landmarkToPixel(rHip, canvasWidth, canvasHeight, videoWidth, videoHeight);

  // Calculate center point
  const centerX = (tlPx.x + trPx.x + blPx.x + brPx.x) / 4;
  const centerY = (tlPx.y + trPx.y + blPx.y + brPx.y) / 4;

  // Calculate dimensions - use shoulder width as reference to maintain aspect ratio
  const shoulderWidth = distance(tlPx, trPx);
  const scale = shoulderWidth * PADDING_FACTOR * SIZE_MULTIPLIER;

  // Both width and height use the same scale to maintain aspect ratio
  const width = scale;
  const height = scale;

  // Calculate rotation from shoulder line
  const rotation = Math.atan2(trPx.y - tlPx.y, trPx.x - tlPx.x);

  return {
    centerX,
    centerY,
    width,
    height,
    rotation
  };
}

/**
 * Calculate affine transform for bottoms (pants, shorts, skirts)
 * Uses 6-point anchor: hips + knees + ankles
 * Projects onto 4-corner rectangle: hips + ankles
 */
function calculateBottomTransform(
  landmarks: PoseLandmark[],
  canvasWidth: number,
  canvasHeight: number,
  videoWidth?: number,
  videoHeight?: number
): ClothingTransform | null {
  // Check visibility
  if (!areLandmarksVisible(landmarks, 'bottoms')) {
    return null;
  }

  // Get landmarks
  const lHip = landmarks[POSE_LANDMARKS.LEFT_HIP];
  const rHip = landmarks[POSE_LANDMARKS.RIGHT_HIP];
  const lAnkle = landmarks[POSE_LANDMARKS.LEFT_ANKLE];
  const rAnkle = landmarks[POSE_LANDMARKS.RIGHT_ANKLE];

  // Convert to pixels
  const tlPx = landmarkToPixel(lHip, canvasWidth, canvasHeight, videoWidth, videoHeight);
  const trPx = landmarkToPixel(rHip, canvasWidth, canvasHeight, videoWidth, videoHeight);
  const blPx = landmarkToPixel(lAnkle, canvasWidth, canvasHeight, videoWidth, videoHeight);
  const brPx = landmarkToPixel(rAnkle, canvasWidth, canvasHeight, videoWidth, videoHeight);

  // Calculate center
  const centerX = (tlPx.x + trPx.x + blPx.x + brPx.x) / 4;
  const centerY = (tlPx.y + trPx.y + blPx.y + brPx.y) / 4;

  // Calculate dimensions - use hip width as reference to maintain aspect ratio
  const hipWidth = distance(tlPx, trPx);
  const scale = hipWidth * PADDING_FACTOR * SIZE_MULTIPLIER;

  // Both width and height use the same scale to maintain aspect ratio
  const width = scale;
  const height = scale;

  // Calculate rotation from hip line
  const rotation = Math.atan2(trPx.y - tlPx.y, trPx.x - tlPx.x);

  return {
    centerX,
    centerY,
    width,
    height,
    rotation
  };
}

/**
 * Calculate clothing transform for any category
 */
export function calculateClothingTransform(
  landmarks: PoseLandmark[],
  category: ClothingCategory,
  canvasWidth: number,
  canvasHeight: number,
  videoWidth?: number,
  videoHeight?: number
): ClothingTransform | null {
  const estimated = estimateMissingLandmarks(landmarks);
  switch (category) {
    case 'tops':
      return calculateTopTransform(estimated, canvasWidth, canvasHeight, videoWidth, videoHeight);
    case 'bottoms':
      return calculateBottomTransform(estimated, canvasWidth, canvasHeight, videoWidth, videoHeight);
  }
}

/**
 * Scale image dimensions to fit target while maintaining aspect ratio
 */
export function scaleToFit(
  imageWidth: number,
  imageHeight: number,
  targetWidth: number,
  targetHeight: number
): { width: number; height: number } {
  const imageAspect = imageWidth / imageHeight;
  const targetAspect = targetWidth / targetHeight;

  if (imageAspect > targetAspect) {
    // Image is wider - fit to width
    return {
      width: targetWidth,
      height: targetWidth / imageAspect,
    };
  } else {
    // Image is taller - fit to height
    return {
      width: targetHeight * imageAspect,
      height: targetHeight,
    };
  }
}

/**
 * Get the 4 corner points for clothing quad mapping
 * This maps clothing image corners directly to body landmarks
 * If anchor points are provided, uses them for precise mapping
 */
export function getClothingQuad(
  landmarks: PoseLandmark[],
  category: ClothingCategory,
  canvasWidth: number,
  canvasHeight: number,
  anchorPoints?: ClothingAnchorPoints,
  videoWidth?: number,
  videoHeight?: number
): ClothingQuad | null {
  const estimated = estimateMissingLandmarks(landmarks);
  // Check visibility
  if (!areLandmarksVisible(estimated, category)) {
    return null;
  }

  // If anchor points provided and valid, use them for direct mapping
  if (anchorPoints && anchorPoints.leftShoulder && anchorPoints.rightShoulder) {
    console.log('Using detected anchor points for precise alignment');
    return mapAnchorsToBody(estimated, category, anchorPoints, canvasWidth, canvasHeight, videoWidth, videoHeight);
  }

  // Fallback to landmark-based quad (original behavior)
  if (category === 'tops') {
    const lShoulder = estimated[POSE_LANDMARKS.LEFT_SHOULDER];
    const rShoulder = estimated[POSE_LANDMARKS.RIGHT_SHOULDER];
    const lHip = estimated[POSE_LANDMARKS.LEFT_HIP];
    const rHip = estimated[POSE_LANDMARKS.RIGHT_HIP];

    return {
      topLeft: landmarkToPixel(lShoulder, canvasWidth, canvasHeight, videoWidth, videoHeight),
      topRight: landmarkToPixel(rShoulder, canvasWidth, canvasHeight, videoWidth, videoHeight),
      bottomLeft: landmarkToPixel(lHip, canvasWidth, canvasHeight, videoWidth, videoHeight),
      bottomRight: landmarkToPixel(rHip, canvasWidth, canvasHeight, videoWidth, videoHeight),
    };
  } else {
    // bottoms
    const lHip = estimated[POSE_LANDMARKS.LEFT_HIP];
    const rHip = estimated[POSE_LANDMARKS.RIGHT_HIP];
    const lAnkle = estimated[POSE_LANDMARKS.LEFT_ANKLE];
    const rAnkle = estimated[POSE_LANDMARKS.RIGHT_ANKLE];

    return {
      topLeft: landmarkToPixel(lHip, canvasWidth, canvasHeight, videoWidth, videoHeight),
      topRight: landmarkToPixel(rHip, canvasWidth, canvasHeight, videoWidth, videoHeight),
      bottomLeft: landmarkToPixel(lAnkle, canvasWidth, canvasHeight, videoWidth, videoHeight),
      bottomRight: landmarkToPixel(rAnkle, canvasWidth, canvasHeight, videoWidth, videoHeight),
    };
  }
}

/**
 * Map detected clothing anchor points to body landmarks
 * Direct mapping: clothing shoulders -> body shoulders exactly
 */
function mapAnchorsToBody(
  landmarks: PoseLandmark[],
  category: ClothingCategory,
  anchors: ClothingAnchorPoints,
  canvasWidth: number,
  canvasHeight: number,
  videoWidth?: number,
  videoHeight?: number
): ClothingQuad {
  if (category === 'tops') {
    // Direct mapping: clothing shoulders -> body shoulders
    const lShoulderLandmark = landmarks[POSE_LANDMARKS.LEFT_SHOULDER];
    const rShoulderLandmark = landmarks[POSE_LANDMARKS.RIGHT_SHOULDER];
    const lHipLandmark = landmarks[POSE_LANDMARKS.LEFT_HIP];
    const rHipLandmark = landmarks[POSE_LANDMARKS.RIGHT_HIP];

    // Convert body landmarks to pixels
    const bodyTopLeft = landmarkToPixel(lShoulderLandmark, canvasWidth, canvasHeight, videoWidth, videoHeight);
    const bodyTopRight = landmarkToPixel(rShoulderLandmark, canvasWidth, canvasHeight, videoWidth, videoHeight);
    const bodyBottomLeft = landmarkToPixel(lHipLandmark, canvasWidth, canvasHeight, videoWidth, videoHeight);
    const bodyBottomRight = landmarkToPixel(rHipLandmark, canvasWidth, canvasHeight, videoWidth, videoHeight);

    return {
      topLeft: bodyTopLeft,
      topRight: bodyTopRight,
      bottomLeft: bodyBottomLeft,
      bottomRight: bodyBottomRight,
    };
  } else {
    // Bottoms: waistband -> hips, hem -> ankles
    const lHipLandmark = landmarks[POSE_LANDMARKS.LEFT_HIP];
    const rHipLandmark = landmarks[POSE_LANDMARKS.RIGHT_HIP];
    const lAnkleLandmark = landmarks[POSE_LANDMARKS.LEFT_ANKLE];
    const rAnkleLandmark = landmarks[POSE_LANDMARKS.RIGHT_ANKLE];

    return {
      topLeft: landmarkToPixel(lHipLandmark, canvasWidth, canvasHeight, videoWidth, videoHeight),
      topRight: landmarkToPixel(rHipLandmark, canvasWidth, canvasHeight, videoWidth, videoHeight),
      bottomLeft: landmarkToPixel(lAnkleLandmark, canvasWidth, canvasHeight, videoWidth, videoHeight),
      bottomRight: landmarkToPixel(rAnkleLandmark, canvasWidth, canvasHeight, videoWidth, videoHeight),
    };
  }
}
