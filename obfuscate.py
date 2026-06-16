import sys
import argparse
from PIL import Image, ImageEnhance, ImageFilter, ImageOps
import numpy as np

def apply_imperceptible_noise(img):
    """
    Applies a very subtle high-frequency noise pattern to disrupt AI detection
    without visibly altering the image to the human eye.
    """
    arr = np.array(img, dtype=np.float32)

    # Generate high-frequency sine wave noise
    x = np.arange(arr.shape[1])
    y = np.arange(arr.shape[0])
    X, Y = np.meshgrid(x, y)

    # Create interference pattern with very high frequency and very low amplitude (max +/- 2 pixel values)
    pattern1 = np.sin(X * 2.0) * np.cos(Y * 2.0)
    pattern2 = np.sin((X+Y) * 1.8)

    noise = (pattern1 + pattern2) * 2.0

    # Apply noise to all channels
    for c in range(3):
        arr[:, :, c] += noise

    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))

def process_image(input_path, output_path):
    img = Image.open(input_path).convert("RGB")

    # 1. Apply imperceptible adversarial-style noise
    img = apply_imperceptible_noise(img)

    # 2. Add an extremely weak random noise (Gaussian noise with std dev of 1.5)
    # This slightly alters the exact color values of flat areas which AI models look at
    arr = np.array(img, dtype=np.float32)
    grain = np.random.normal(0, 1.5, arr.shape)
    arr = np.clip(arr + grain, 0, 255).astype(np.uint8)
    img = Image.fromarray(arr)

    # Note: We completely removed blur, downsampling, and rotation to keep the image crisp and identical.

    # 3. Save with high JPEG quality to maintain crispness, but let PIL re-encode
    # to alter the underlying DCT compression artifacts that AI detectors also look for.
    img.save(output_path, "JPEG", quality=98, optimize=True)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Obfuscate image")
    parser.add_argument("input", help="Input image path")
    parser.add_argument("output", help="Output image path")
    args = parser.parse_args()

    process_image(args.input, args.output)
    print(f"Obfuscated image saved to {args.output}")
