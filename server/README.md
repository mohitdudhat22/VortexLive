Solutions:
Option 1: Use File Mode (Recommended for testing)
Loop a local video file:
bashINPUT_MODE=file FILENAME=input.mp4 node stream-test.js
Make sure you have a file called input.mp4 in your directory (or specify the full path).
Option 2: Use TCP Mode
Start a TCP server that waits for a video stream:
bashINPUT_MODE=tcp PORT=10000 INPUT_FORMAT=mp4 node stream-test.js
Then connect from another terminal or application that streams video to localhost:10000.
Option 3: Pipe Video Data to Stdin
Stream a video file into the script:
bashcat your-video.mp4 | node stream-test.js
Or from ffmpeg:
bashffmpeg -re -i your-video.mp4 -c copy -f mp4 - | node stream-test.js
Quick Test
The easiest way to test is file mode:
bash# If you have a video file named input.mp4
INPUT_MODE=file node stream-test.js

# Or specify a different file

INPUT_MODE=file FILENAME=/path/to/your/video.mp4 node stream-test.js
