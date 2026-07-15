<template>
  <main class="main-content">
    <div class="row">
      <div class="col-lg-4">
        <b-overlay :show="loading.status" opacity="0.6" rounded="lg" class="card">
          <div class="card-body">
            <div class="d-flex justify-content-between mb-2">
              <h5>وضعیت جستجوگر</h5>
              <button @click="browserToggleStatus(browserStatus=='on'?'off':'on')" :class="['btn', (browserStatus=='on'?'btn-success':'btn-danger')]">{{ browserStatus=='on'?'فعال':'غیر فعال' }}</button>
            </div>

            <hr>

            <div class="d-flex justify-content-between">
              <h5>وضعیت ربات چک</h5>
              <button @click="pingToggleStatus(pingStatus=='on'?'off':'on')" :class="['btn', (pingStatus=='on'?'btn-success':'btn-danger')]">{{ pingStatus=='on'?'فعال':'غیر فعال' }}</button>
            </div>
          </div>
        </b-overlay>
        <div class="card text-white bg-secondary">
          <div class="card-header">ترمینال</div>
          <ul class="card-body card-terminal">
            <li v-if="!terminal.length">user@abcrm:~$ <span class="fa fa-blink">_</span></li>
            <li v-else v-for="cmd of terminal" :class="(cmd.type=='danger'?'text-danger':(cmd.type=='warning'?'text-warning':''))">{{cmd.text}}</li>
          </ul>
        </div>
        <div class="card">
          <div class="card-header d-flex justify-content-between">آمار پراکسی ها<span class="text-muted">{{ number_format(countOfAll) }}</span></div>
          <div class="card-body">
            <div class="mb-4 text-center">
              <div class="position-relative">
                <div id="sales-circle-graphic" class="circle"></div>
                <div class="position-absolute a-0 d-flex flex-column align-items-center justify-content-center">
                  <h3 class="mb-1 line-height-20 primary-font">{{ okPercent }}%</h3>
                  <span class="font-size-13">پراکسی‌های سالم</span>
                </div>
              </div>
            </div>
            <div class="list-group list-group-flush m-t-10">
              <div class="list-group-item p-t-b-10 p-l-r-0 d-flex align-items-center justify-content-between">
                <div class="d-flex align-items-center">
                  <i class="fa fa-circle m-l-10 text-success"></i>
                  <span>سالم</span>
                </div>
                <div class="d-flex align-items-center">
                  <div class="m-l-20">{{ number_format(okCount) }}</div>
                  <div dir="ltr" class="w-75 text-left">{{ ((okCount/countOfAll)*100).toFixed(2) }}%</div>
                </div>
              </div>
              <div class="list-group-item p-t-b-10 p-l-r-0 d-flex align-items-center justify-content-between">
                <div class="d-flex align-items-center">
                  <i class="fa fa-circle m-l-10 text-info"></i>
                  <span>در حال چک</span>
                </div>
                <div class="d-flex align-items-center">
                  <div class="m-l-20">{{ number_format(pendingCount) }}</div>
                  <div dir="ltr" class="w-75 text-left">{{ ((pendingCount/countOfAll)*100).toFixed(2) }}%</div>
                </div>
              </div>
              <div class="list-group-item p-t-b-10 p-l-r-0 d-flex align-items-center justify-content-between">
                <div class="d-flex align-items-center">
                  <i class="fa fa-circle m-l-10 text-warning"></i>
                  <span>تایم اوت</span>
                </div>
                <div class="d-flex align-items-center">
                  <div class="m-l-20">{{ number_format(timeOutCount) }}</div>
                  <div dir="ltr" class="w-75 text-left">{{ ((timeOutCount/countOfAll)*100).toFixed(2) }}%</div>
                </div>
              </div>
              <div class="list-group-item p-t-b-10 p-l-r-0 d-flex align-items-center justify-content-between">
                <div class="d-flex align-items-center">
                  <i class="fa fa-circle m-l-10 text-danger"></i>
                  <span>خراب</span>
                </div>
                <div class="d-flex align-items-center">
                  <div class="m-l-20">{{ number_format(badCount) }}</div>
                  <div dir="ltr" class="w-75 text-left">{{ ((badCount/countOfAll)*100).toFixed(2) }}%</div>
                </div>
              </div>
              <div class="list-group-item p-t-b-10 p-l-r-0 d-flex align-items-center justify-content-between">
                <div class="d-flex align-items-center">
                  <i class="fa fa-circle m-l-10 text-muted"></i>
                  <span>بررسی نشده</span>
                </div>
                <div class="d-flex align-items-center">
                  <div class="m-l-20">{{ number_format(unknownCount) }}</div>
                  <div dir="ltr" class="w-75 text-left">{{ ((unknownCount/countOfAll)*100).toFixed(2) }}%</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="col-lg-8">
        <b-overlay :show="loading.items" opacity="0.6" rounded="lg" class="card">
          <div class="card-header d-flex justify-content-between align-items-center">۵۰ تا آخرین پراکسی های سالم
            <button @click="getProxyList" class="btn btn-light"><i class="fad fa-sync-alt"></i></button>
          </div>
          <div class="card-body p-0">
            <div class="card-scroll h-100">
              <div class="table-responsive">
                <table class="table" width="100%">
                  <thead>
                  <tr>
                    <th>آدرس IP</th>
                    <th>پورت</th>
                    <th>لوکیشن</th>
                    <th>پروتوکل</th>
                    <th>بروزرسانی</th>
                  </tr>
                  </thead>
                  <tbody>
                  <tr v-for="proxy of proxyList">
                    <td>{{proxy.ip}}</td>
                    <td>{{proxy.port}}</td>
                    <td>{{proxy.country}}</td>
                    <td>{{proxy.protocol}}</td>
                    <td>{{new Date(proxy.updatedAt).echoFa('Y/m/d - H:i:s')}}</td>
                  </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </b-overlay>
      </div>
    </div>

  </main>
</template>

<script>
import axios from "axios";
import util from "../../assets/pureFunctions.js"
export default {
  name: "Proxies",
  data(){
    return {
      number_format: util.number_format,
      browserStatus: "on",
      pingStatus: "on",
      loading: {items: false, status: false},
      proxyList: [],
      countOfAll: 0,
      okPercent: 0,
      okCount: 0,
      pendingCount: 0,
      timeOutCount: 0,
      badCount: 0,
      unknownCount: 0,
      terminal: []
    }
  },
  methods: {
    pushToTerminal(cmd){
      if( this.terminal.length == 8 ){
        this.terminal.splice(0, 1);
      }
      this.terminal.push(cmd);
    },
    browserToggleStatus(status){
      this.loading.status = true;
      axios.put('/admin/settings/proxies/data/browserStatus', {status}).then(({data}) => {
        if(data.ok){
          this.browserStatus = data.status
        }
        this.loading.status = false;
      });
    },
    pingToggleStatus(status){
      this.loading.status = true;
      axios.put('/admin/settings/proxies/data/pingStatus', {status}).then(({data}) => {
        if(data.ok){
          this.pingStatus = data.status
        }
        this.loading.status = false;
      });
    },
    getProxyList(){
      this.loading.items = true;
      axios.get('/admin/settings/proxies/data/proxy-list').then(({data}) => {
        if(data.ok){
          this.proxyList = data.list
        }
        this.loading.items = false;
      });
    },
    getInfo(){
      axios.get('/admin/settings/proxies/data/info').then(({data}) => {
        if(data){
          this.countOfAll = data.all;
          this.okCount = data.ok;
          this.okPercent = ((this.okCount/this.countOfAll)*100).toFixed(1);
          this.timeOutCount = data.timeout;
          this.pendingCount = data.pending;
          this.badCount = data.bad;
          this.unknownCount = data.unknown;
          this.browserStatus = data.settings.browserStatus;
          this.pingStatus = data.settings.pingStatus;
        }
      });
    }
  },
  watch: {
    okPercent: {
      handler: function(){
        $('#sales-circle-graphic').circleProgress({
          value: this.okPercent/100,
        });
      }
    }
  },
  created(){
    const vm = this;
    this.getProxyList();
    this.getInfo();
    $(function(){
      if ($('#sales-circle-graphic').length) {
        $('#sales-circle-graphic').circleProgress({
          startAngle: 1.55,
          value: vm.okPercent/100,
          size: 180,
          thickness: 30,
          animation:false,
          fill: {
            color: "#0ABB87"
          }
        });
      }
    });
    socket.on('proxy log', (data) => {
      vm.pushToTerminal(data);
    })
    socket.on('proxy info', (data) => {
      vm.countOfAll = data.all;
      vm.okCount = data.ok;
      vm.okPercent = ((vm.okCount/vm.countOfAll)*100).toFixed(1);
      vm.timeOutCount = data.timeout;
      vm.pendingCount = data.pending;
      vm.badCount = data.bad;
      vm.unknownCount = data.unknown;
    })
  }
}
</script>

<style scoped>
.card-terminal{
  direction: ltr;
  text-align: left;
  font-family: sans-serif, Arial, Verdana, "Trebuchet MS", "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
  font-size: 11px;
  padding: 10px;
  color: #00CC74;
  height: 117px;
  line-height: 12px;
}
@keyframes fa-blink {
  0% { opacity: 1; }
  50% { opacity: 1; }
  100% { opacity: 0; }
}
.fa-blink {
  animation: fa-blink .75s linear infinite;
}
</style>
