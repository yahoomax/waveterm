package wslconn

import (
	"strings"
	"testing"
)

func TestConnServerCmdTemplateAvoidsGroupedFallback(t *testing.T) {
	if strings.Contains(ConnServerCmdTemplate, "(echo -n \"not-installed \")") {
		t.Fatalf("ConnServerCmdTemplate must not use grouped fallback syntax for not-installed")
	}
	if !strings.Contains(ConnServerCmdTemplate, "%s version 2> /dev/null || echo not-installed;") {
		t.Fatalf("ConnServerCmdTemplate must include a simple shell-safe not-installed fallback")
	}
}
