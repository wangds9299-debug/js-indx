from flask import Flask, request, send_file, render_template, jsonify, after_this_request
import os
import uuid
import tempfile
from obfuscate import process_image

app = Flask(__name__)

# Ensure there's a temporary directory for processing
UPLOAD_FOLDER = tempfile.gettempdir()

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/obfuscate', methods=['POST'])
def api_obfuscate():
    if 'image' not in request.files:
        return jsonify({'error': 'No image provided'}), 400

    file = request.files['image']
    if file.filename == '':
        return jsonify({'error': 'Empty file name'}), 400

    if file:
        # Generate unique filenames
        unique_id = str(uuid.uuid4())
        input_filename = f"input_{unique_id}.jpg"
        output_filename = f"output_{unique_id}.jpg"

        input_path = os.path.join(UPLOAD_FOLDER, input_filename)
        output_path = os.path.join(UPLOAD_FOLDER, output_filename)

        try:
            file.save(input_path)

            # Process the image
            process_image(input_path, output_path)

            @after_this_request
            def cleanup(response):
                try:
                    if os.path.exists(input_path):
                        os.remove(input_path)
                    if os.path.exists(output_path):
                        os.remove(output_path)
                except Exception as cleanup_err:
                    app.logger.error(f"Error cleaning up files: {cleanup_err}")
                return response

            # Send the file back
            return send_file(output_path, mimetype='image/jpeg', as_attachment=True, download_name='obfuscated.jpg')
        except Exception as e:
            # Clean up the input file if processing fails
            if os.path.exists(input_path):
                try:
                    os.remove(input_path)
                except:
                    pass
            return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
