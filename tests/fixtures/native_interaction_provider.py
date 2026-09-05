"""Loopback-only deterministic model endpoint for native worker/browser QA.
Not a real model: only the external provider is substituted. Hermes tools,
worker, JSONL, database, upload, HTTP routes, and browser stay real.
"""
import json
import os
from typing import Any
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any):
        print(format % args, flush=True)
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"object":"list","data":[{"id":"qa-fixture","object":"model","owned_by":"qa"}]}).encode())
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        messages = body.get("messages", [])
        last_user = max((i for i,m in enumerate(messages) if m.get("role")=="user"), default=0)
        answered = [m for m in messages[last_user+1:] if m.get("role")=="tool"]
        message: dict[str, Any]
        if answered:
            message={"role":"assistant","content":"QA fixture received the task answers: "+str(answered[-1].get("content", ""))}
            reason="stop"
        elif body.get("tools"):
            message={"role":"assistant","content":None,"tool_calls":[{"id":"call_qa_questions","type":"function","function":{"name":"clarify","arguments":json.dumps({"questions":[{"question":"Which task scope?","choices":["Core only","Full package"]},{"question":"Which checks should run?","choices":["Tests","Independent review"],"multi_select":True},{"question":"Any additional constraints?"}]})}}]}
            reason="tool_calls"
        else:
            message={"role":"assistant","content":"Question form QA"}
            reason="stop"
        self.send_response(200)
        if body.get("stream"):
            self.send_header("Content-Type","text/event-stream")
            self.end_headers()
            delta={k:v for k,v in message.items() if v is not None}
            if "tool_calls" in delta:
                delta["tool_calls"][0]["index"]=0
            for data in [{"id":"chatcmpl-qa","object":"chat.completion.chunk","model":"qa-fixture","choices":[{"index":0,"delta":delta,"finish_reason":None}]},{"id":"chatcmpl-qa","object":"chat.completion.chunk","model":"qa-fixture","choices":[{"index":0,"delta":{},"finish_reason":reason}],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}]:
                self.wfile.write(("data: "+json.dumps(data)+"\n\n").encode())
            self.wfile.write(b"data: [DONE]\n\n")
        else:
            self.send_header("Content-Type","application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"id":"chatcmpl-qa","object":"chat.completion","model":"qa-fixture","choices":[{"index":0,"message":message,"finish_reason":reason}],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}).encode())
        self.wfile.flush()

ThreadingHTTPServer(("127.0.0.1", int(os.environ["OLYMPUS_QA_PROVIDER_PORT"])), Handler).serve_forever()
