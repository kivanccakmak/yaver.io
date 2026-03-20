// Example: Voice input — record audio, transcribe, send as task.
package main

import (
	"fmt"
	"log"
	"os"

	yaver "github.com/kivanccakmak/yaver.io/sdk/go/yaver"
)

func main() {
	url := os.Getenv("YAVER_URL")
	token := os.Getenv("YAVER_TOKEN")
	if url == "" || token == "" {
		log.Fatal("Set YAVER_URL and YAVER_TOKEN env vars")
	}

	// Configure speech (use local whisper or set OPENAI_API_KEY)
	provider := "whisper"
	apiKey := ""
	if k := os.Getenv("OPENAI_API_KEY"); k != "" {
		provider = "openai"
		apiKey = k
	}

	// Record audio
	fmt.Println("Press Enter to start recording...")
	fmt.Scanln()
	audioPath, err := yaver.RecordAudio()
	if err != nil {
		log.Fatalf("Recording failed: %v", err)
	}
	defer os.Remove(audioPath)

	// Transcribe
	fmt.Println("Transcribing...")
	tr := yaver.NewTranscriber(&yaver.SpeechConfig{
		Provider: provider,
		APIKey:   apiKey,
	})
	result, err := tr.Transcribe(audioPath)
	if err != nil {
		log.Fatalf("Transcription failed: %v", err)
	}
	fmt.Printf("You said: %s (took %v)\n\n", result.Text, result.Duration)

	// Send as task
	client := yaver.NewClient(url, token)
	v := 5
	task, err := client.CreateTask(result.Text, &yaver.CreateTaskOptions{
		SpeechContext: &yaver.SpeechContext{
			InputFromSpeech: true,
			STTProvider:     provider,
			Verbosity:       &v,
		},
	})
	if err != nil {
		log.Fatalf("Create task failed: %v", err)
	}

	// Stream output
	for chunk := range client.StreamOutput(task.ID, 0) {
		fmt.Print(chunk)
	}

	// TTS
	final, _ := client.GetTask(task.ID)
	if final.ResultText != "" {
		fmt.Println("\n\nSpeaking result...")
		yaver.Speak(final.ResultText)
	}
}
