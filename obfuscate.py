import sys
import argparse
from PIL import Image, ImageEnhance, ImageFilter, ImageOps
import numpy as np
import io

def apply_glaze_like_noise(img, strength=10):
    """
    Applies an adversarial-like noise pattern to the image to disrupt deep learning models.
    """
    arr = np.array(img, dtype=np.float32)
    # Generate high-frequency sine wave noise
    x = np.arange(arr.shape[1])
    y = np.arange(arr.shape[0])
    X, Y = np.meshgrid(x, y)

    # Create interference pattern
    pattern1 = np.sin(X * 0.8) * np.cos(Y * 0.8)
    pattern2 = np.sin((X+Y) * 0.5)

    noise = (pattern1 + pattern2) * strength

    # Apply noise to all channels
    for c in range(3):
        arr[:, :, c] += noise

    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))

def process_image(input_path, output_path):
    img = Image.open(input_path).convert("RGB")

    # Advanced obfuscation techniques to alter image characteristics

    # 1. Apply Glaze-like noise to disrupt spatial patterns
    img = apply_glaze_like_noise(img, strength=25)

    # 2. Add film grain
    arr = np.array(img, dtype=np.float32)
    grain = np.random.normal(0, 20, arr.shape)
    arr = np.clip(arr + grain, 0, 255).astype(np.uint8)
    img = Image.fromarray(arr)

    # 3. Simulate extreme downsampling and upsampling
    w, h = img.size
    img = img.resize((int(w*0.15), int(h*0.15)), Image.NEAREST)
    img = img.resize((w, h), Image.BICUBIC)

    # 4. Save with heavy JPEG compression
    buffer = io.BytesIO()
    img.save(buffer, format="JPEG", quality=20)
    buffer.seek(0)
    img = Image.open(buffer)

    # 5. Rotation to misalign grids
    img = img.rotate(3.5, expand=False, resample=Image.BICUBIC, fillcolor='white')

    # 6. Apply slight blur
    img = img.filter(ImageFilter.GaussianBlur(radius=1.2))

    # 7. Add a subtle pattern overlay
    arr = np.array(img, dtype=np.float32)
    x = np.arange(arr.shape[1])
    y = np.arange(arr.shape[0])
    X, Y = np.meshgrid(x, y)
    grid = (X % 4 < 2) & (Y % 4 < 2)
    arr[grid] *= 0.95
    img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))

    # Final save
    img.save(output_path, "JPEG", quality=65, optimize=True)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Obfuscate image")
    parser.add_argument("input", help="Input image path")
    parser.add_argument("output", help="Output image path")
    args = parser.parse_args()

    process_image(args.input, args.output)
    print(f"Obfuscated image saved to {args.output}")
