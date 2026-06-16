# Image Obfuscation Application

This project provides a script and a web interface to apply various image processing techniques to alter image characteristics, which can help evade AI generated content detectors.

## Prerequisites

You need Python installed on your system. You also need to install the required Python libraries. You can install them using `pip`:

```bash
pip install Flask Pillow numpy
```

## Web Interface

To start the web application, run the Flask server:

```bash
python app.py
```

Then, open your web browser and navigate to:
`http://localhost:5000`

You can upload an image through the web interface, and it will automatically process and download the obfuscated result.

## Command Line Usage

You can also run the core obfuscation script directly from the command line by providing the input image path and the desired output image path.

```bash
python obfuscate.py <input_image_path> <output_image_path>
```

### Example

To process an image named `input.jpg` and save the result as `output.jpg`, run:

```bash
python obfuscate.py input.jpg output.jpg
```
