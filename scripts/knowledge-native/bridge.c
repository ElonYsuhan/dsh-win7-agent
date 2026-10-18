/* Agent SQLite bridge v1. Trusted service SQL only; never exposed to renderer. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "sqlite3.h"
#ifdef _WIN32
#include <windows.h>
#include <io.h>
#include <fcntl.h>
#endif
static size_t output_bytes=0;
static int first=1;
static void out(const char *s){size_t n=strlen(s);output_bytes+=n;if(output_bytes>16*1024*1024)exit(4);fwrite(s,1,n,stdout);}
static void quoted(const char *s){const unsigned char *p=(const unsigned char*)s;out("\"");while(*p){char b[8];if(*p=='"'||*p=='\\'){b[0]='\\';b[1]=*p;b[2]=0;out(b);}else if(*p<32){snprintf(b,sizeof b,"\\u%04x",*p);out(b);}else{b[0]=*p;b[1]=0;out(b);}p++;}out("\"");}
static int row(void *unused,int n,char **values,char **names){(void)unused;if(!first)out(",");first=0;out("{");for(int i=0;i<n;i++){if(i)out(",");quoted(names[i]);out(":");if(values[i])quoted(values[i]);else out("null");}out("}");return 0;}
static int run(const char *file){
 sqlite3 *db=0;char *error=0;size_t cap=4096,len=0;char *sql=malloc(cap);if(!sql)return 2;
#ifdef _WIN32
 _setmode(_fileno(stdin),_O_BINARY);_setmode(_fileno(stdout),_O_BINARY);
#endif
 while(!feof(stdin)){if(len+2048+1>cap){cap*=2;if(cap>16*1024*1024){free(sql);return 3;}char *next=realloc(sql,cap);if(!next){free(sql);return 2;}sql=next;}size_t n=fread(sql+len,1,2048,stdin);len+=n;if(ferror(stdin)){free(sql);return 2;}}
 sql[len]=0;
 int rc=sqlite3_open_v2(file,&db,SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE,0);
 if(rc==SQLITE_OK){sqlite3_busy_timeout(db,5000);sqlite3_limit(db,SQLITE_LIMIT_LENGTH,8*1024*1024);sqlite3_limit(db,SQLITE_LIMIT_SQL_LENGTH,16*1024*1024);sqlite3_db_config(db,SQLITE_DBCONFIG_DEFENSIVE,1,0);rc=sqlite3_exec(db,"PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; PRAGMA max_page_count=32768;",0,0,&error);}
 out("{\"rows\":[");if(rc==SQLITE_OK)rc=sqlite3_exec(db,sql,row,0,&error);out("],\"error\":");if(rc==SQLITE_OK)out("null");else quoted(error?error:sqlite3_errmsg(db));out("}\n");
 sqlite3_free(error);sqlite3_close(db);free(sql);return rc==SQLITE_OK?0:1;
}
#ifdef _WIN32
int wmain(int argc,wchar_t **argv){if(argc!=2)return 2;int n=WideCharToMultiByte(CP_UTF8,0,argv[1],-1,0,0,0,0);char *file=malloc(n);if(!file)return 2;WideCharToMultiByte(CP_UTF8,0,argv[1],-1,file,n,0,0);int rc=run(file);free(file);return rc;}
#else
int main(int argc,char **argv){return argc==2?run(argv[1]):2;}
#endif
