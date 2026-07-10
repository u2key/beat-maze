import sys
import os
import json
import librosa

def analyze_mp3(file_path, output_json_path):
    if not os.path.exists(file_path):
        print(f"Error: File {file_path} does not exist.")
        sys.exit(1)
        
    print(f"Loading audio file: {file_path}...")
    # Load with native sample rate
    y, sr = librosa.load(file_path, sr=None)
    
    print("Estimating tempo (BPM)...")
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
    # tempo can be a float or array/list depending on librosa version
    if hasattr(tempo, '__iter__'):
        tempo = float(tempo[0])
    else:
        tempo = float(tempo)
    
    import math
    if tempo <= 0 or math.isnan(tempo):
        tempo = 120.0
        
    print(f"Estimated Tempo: {tempo:.2f} BPM")
    
    print("Detecting note onsets...")
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    onsets = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr, units='time')
    
    # We want to filter onsets so they are not too close together.
    # Minimum gap between turns should be based on tempo, e.g., 8th note duration.
    # At 120 BPM, an 8th note is 0.25 seconds. Let's make it min 0.22 seconds.
    min_gap = 60.0 / tempo / 2.0  # 8th note duration
    if min_gap < 0.2:
        min_gap = 0.2
    
    print(f"Filtering onsets (minimum gap: {min_gap:.3f}s)...")
    filtered_onsets = []
    last_time = -999.0
    for t in onsets:
        t = float(t)
        if t - last_time >= min_gap:
            filtered_onsets.append(t)
            last_time = t
            
    # Generate alternating segments/turns
    segments = []
    current_dir = 0
    
    # The first node starts at 0.0 moving in dir 0
    segments.append({
        "time": 0.0,
        "dir": 0
    })
    
    # We want a 2-second lead-in delay where the player doesn't have to turn immediately.
    # So we ignore any detected onsets in the first 2.0 seconds.
    lead_in = 2.5
    for t in filtered_onsets:
        if t < lead_in:
            continue
        current_dir = 1 - current_dir
        segments.append({
            "time": t,
            "dir": current_dir
        })
        
    # Build song metadata
    song_data = {
        "title": os.path.basename(file_path).replace('.mp3', '').replace('_', ' ').title(),
        "bpm": round(tempo, 2),
        "leadIn": lead_in,
        "segments": segments
    }
    
    # Ensure output directory exists
    os.makedirs(os.path.dirname(os.path.abspath(output_json_path)), exist_ok=True)
    
    with open(output_json_path, 'w', encoding='utf-8') as f:
        json.dump(song_data, f, indent=2)
        
    print(f"Successfully generated notes! Saved to {output_json_path}")
    print(f"Total turns: {len(segments) - 1}")

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python generate_notes.py <input.mp3> <output.json>")
        sys.exit(1)
    analyze_mp3(sys.argv[1], sys.argv[2])
