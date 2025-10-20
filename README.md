# Local Python Step-by-Step Visualizer

A lightweight clone of the Python Tutor experience that runs entirely on your machine. Paste or type Python code, execute it safely inside a sandboxed subprocess, and inspect the program one step at a time with textual and graphical state views.

## Features
- Step-by-step execution trace with locals, globals, return values, and exceptions
- Interactive navigation controls with keyboard-friendly prev/next buttons and a scrubber slider for the recorded trace
- Python Tutor-style inspector showing stack frames, locals/globals, and a heap view with reference highlighting
- Split view UI pairing the traced source with state inspection panels
- Local-only runtime powered by Flask and Python's tracing hooks (no external services)

## Requirements
- Python 3.10 or newer (tested with Python 3.11)
- `pip` for dependency installation

## Installation
1. Create and activate a virtual environment (recommended):
   ```bash
   python -m venv .venv
   source .venv/bin/activate    # On Windows PowerShell: .venv\Scripts\Activate.ps1
   ```
2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

## Running the App
```bash
python app.py
```
Then open a browser to <http://127.0.0.1:5000/>.

### Alternative launch using Flask's CLI
```bash
flask --app app run --no-reload
```

## Using the Visualizer
1. Enter or paste Python code in the editor panel (sample provided via the *Load sample* button).
2. Click **Run & Visualize** to execute and capture a trace.
3. Step forward/backward with the navigation buttons to inspect each execution state.
4. Review the textual locals/globals view alongside graphical cards that chart numeric values, sequences, and mappings.
5. The progress bar indicates where you are in the recorded trace. If execution times out or hits the step cap, a note appears beneath the visuals.

## Safety & Limits
- Execution runs in a separate process with a 3-second timeout and a 2,000-step trace cap to avoid runaway programs.
- Standard output and errors are captured and shown in dedicated panels.
- Only run code you trust; although isolated, the subprocess still executes locally on your machine.

## Project Structure
```
app.py                # Flask backend + sandboxed execution
requirements.txt      # Python dependencies
static/
  index.html          # UI layout
  css/style.css       # Styling and theming
  js/app.js           # Front-end logic, trace controls, and graphics
```

## Development Tips
- Modify `MAX_STEPS` or `EXEC_TIMEOUT` in `app.py` if you need longer traces (be mindful of safety).
- Front-end assets live under `static/`; changes reload automatically when the Flask dev server restarts.
- Consider adding unit tests around `serialize_value` or the tracing pipeline if you extend the backend.
