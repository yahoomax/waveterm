# add wsh to path, source dynamic script from wsh token
setenv WAVETERM_WSHBINDIR {{.WSHBINDIR}}
setenv PATH "${WAVETERM_WSHBINDIR}:$PATH"

# restore HOME before token exchange so wsh can find the domain socket
if ($?WAVETERM_ORIG_HOME) then
    setenv HOME "$WAVETERM_ORIG_HOME"
    set home = "$WAVETERM_ORIG_HOME"
    unsetenv WAVETERM_ORIG_HOME
endif

set _waveterm_token_tmpfile = "/tmp/.waveterm-init-csh-$$.sh"
wsh token csh >! "$_waveterm_token_tmpfile"
if (-f "$_waveterm_token_tmpfile") then
    source "$_waveterm_token_tmpfile"
    /bin/rm -f "$_waveterm_token_tmpfile"
endif
unset _waveterm_token_tmpfile
unsetenv WAVETERM_SWAPTOKEN

if (-f ~/.cshrc) then
    source ~/.cshrc
endif

if ("$PATH" !~ *"$WAVETERM_WSHBINDIR"*) then
    setenv PATH "${WAVETERM_WSHBINDIR}:$PATH"
endif
unsetenv WAVETERM_WSHBINDIR

# load completions if available (fail silently if wsh completion fails)
set _waveterm_completion_file = "/tmp/wsh-completion-csh-$$.tmp"
if (-x ~/.waveterm/bin/wsh) then
    ~/.waveterm/bin/wsh completion csh >! "$_waveterm_completion_file"
    if (-f "$_waveterm_completion_file") then
        source "$_waveterm_completion_file"
        /bin/rm -f "$_waveterm_completion_file"
    endif
endif
unset _waveterm_completion_file

if (! $?_WAVETERM_SI_FIRSTPROMPT) then
    set _WAVETERM_SI_FIRSTPROMPT = 1
endif

# Pre-initialize integration variables at startup to avoid undefined variable errors on Ctrl+C
set _waveterm_pwd = ""
set _waveterm_si_status = 0
set _waveterm_si_block = 0
set _waveterm_cmd64 = ""

alias _waveterm_si_blocked 'if ( $?TMUX || $?STY || "$TERM" =~ tmux* || "$TERM" =~ screen* ) echo 1; if ( ! $?TMUX && ! $?STY && "$TERM" !~ tmux* && "$TERM" !~ screen* ) echo 0'

# Sequential checks avoid csh parse-time undefined-variable faults on Ctrl+C.
alias _waveterm_si_precmd 'set _waveterm_si_status = $status; set _waveterm_si_block = `_waveterm_si_blocked`; if ("$_waveterm_si_block" == "0") if ($_WAVETERM_SI_FIRSTPROMPT == 1) printf "\033]16162;M;{\x22shell\x22:\x22csh\x22,\x22shellversion\x22:\x22$version\x22,\x22uname\x22:\x22%s\x22,\x22integration\x22:true}\007" "`uname -smr`"; if ("$_waveterm_si_block" == "0") if ($_WAVETERM_SI_FIRSTPROMPT != 1) printf "\033]16162;D;{\x22exitcode\x22:%d}\007" $_waveterm_si_status; if ("$_waveterm_si_block" == "0") set _waveterm_pwd = `echo "$cwd" | sed -e "s/%/%25/g" -e "s/ /%20/g" -e "s/#/%23/g" -e "s/?/%3F/g" -e "s/&/%26/g" -e "s/;/%3B/g" -e "s/+/%2B/g"`; if ("$_waveterm_si_block" == "0") if ($?_waveterm_pwd) if ("$_waveterm_pwd" != "") printf "\033]7;file://localhost%s\007" "$_waveterm_pwd"; if ("$_waveterm_si_block" == "0") printf "\033]16162;A\007"; if ("$_waveterm_si_block" == "0") if ($_WAVETERM_SI_FIRSTPROMPT == 1) set _WAVETERM_SI_FIRSTPROMPT = 0'

# csh does not provide preexec hooks; prompt-time integration is best effort.
set prompt = '`_waveterm_si_precmd`% '
