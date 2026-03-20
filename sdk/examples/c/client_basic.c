/**
 * Basic C client — connect to agent, create task, print result.
 *
 * Build:
 *   cd sdk/go/clib && go build -buildmode=c-shared -o libyaver.so .
 *   gcc -o client_basic client_basic.c -L../../go/clib -lyaver -Wl,-rpath,../../go/clib
 *
 * Run:
 *   YAVER_URL=http://localhost:18080 YAVER_TOKEN=xxx ./client_basic
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../../go/clib/libyaver.h"

int main() {
    const char* url = getenv("YAVER_URL");
    const char* token = getenv("YAVER_TOKEN");

    if (!url || !token) {
        fprintf(stderr, "Set YAVER_URL and YAVER_TOKEN env vars\n");
        return 1;
    }

    /* Create client */
    int client = YaverNewClient((char*)url, (char*)token);

    /* Health check */
    char* health = YaverHealth(client);
    printf("Health: %s\n", health);
    YaverFreeString(health);

    /* Ping */
    char* ping = YaverPing(client);
    printf("Ping: %s\n", ping);
    YaverFreeString(ping);

    /* Create task */
    char* task = YaverCreateTask(client, "List files in the current directory", NULL);
    printf("Task created: %s\n", task);
    YaverFreeString(task);

    /* List tasks */
    char* tasks = YaverListTasks(client);
    printf("Tasks: %s\n", tasks);
    YaverFreeString(tasks);

    /* Clean up */
    YaverFreeClient(client);
    printf("Done.\n");
    return 0;
}
