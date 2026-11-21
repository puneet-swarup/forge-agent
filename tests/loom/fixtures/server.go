package main

import (
	"fmt"
	"strings"
)

import "os"

// Handler serves requests.
type Handler struct {
	Name string
}

func (h *Handler) Serve(w int) {
	fmt.Println("}", w)
}

func main() {
	Serve(1)
}
