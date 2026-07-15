<template>
  <main class="main-content">
    <div class="row">
      <b-overlay class="col-lg-9" :show="loading.search" rounded opacity="0.6" spinner-small spinner-variant="primary">
        <div class="d-flex justify-content-center align-items-center">
          <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:svgjs="http://svgjs.com/svgjs" version="1.1" width="64" height="64" x="0" y="0" viewBox="0 0 612 612" style="enable-background:new 0 0 512 512" xml:space="preserve" class=""><g><g xmlns="http://www.w3.org/2000/svg"><g><path d="M226.764,375.35c-28.249,0-51.078,22.91-51.078,51.16c0,28.166,22.829,51.078,51.078,51.078s51.078-22.912,51.078-51.078    C277.841,398.26,255.013,375.35,226.764,375.35z M226.764,452.049c-14.125,0-25.54-11.498-25.54-25.541    c0-14.123,11.415-25.539,25.54-25.539c14.124,0,25.539,11.416,25.539,25.539C252.302,440.551,240.888,452.049,226.764,452.049z     M612,337.561v54.541c0,13.605-11.029,24.635-24.636,24.635h-26.36c-4.763-32.684-32.929-57.812-66.927-57.812    c-33.914,0-62.082,25.129-66.845,57.812H293.625c-4.763-32.684-32.93-57.812-66.845-57.812c-33.915,0-62.082,25.129-66.844,57.812    h-33.012c-13.606,0-24.635-11.029-24.635-24.635v-54.541H612L612,337.561z M494.143,375.35c-28.249,0-51.16,22.91-51.16,51.16    c0,28.166,22.912,51.078,51.16,51.078c28.166,0,51.077-22.912,51.077-51.078C545.22,398.26,522.309,375.35,494.143,375.35z     M494.143,452.049c-14.125,0-25.539-11.498-25.539-25.541c0-14.123,11.414-25.539,25.539-25.539    c14.042,0,25.539,11.416,25.539,25.539C519.682,440.551,508.185,452.049,494.143,452.049z M602.293,282.637l-96.817-95.751    c-6.159-6.077-14.453-9.526-23.076-9.526h-48.86v-18.313c0-13.631-11.004-24.635-24.635-24.635H126.907    c-13.55,0-24.635,11.005-24.635,24.635v3.86L2.3,174.429l177.146,23.068L0,215.323l178.814,25.423L0,256.25l102.278,19.29    l-0.007,48.403h509.712v-17.985C611.983,297.171,608.452,288.796,602.293,282.637z M560.084,285.839h-93.697    c-2.135,0-3.86-1.724-3.86-3.859v-72.347c0-2.135,1.725-3.86,3.86-3.86h17.82c0.985,0,1.971,0.411,2.71,1.068l75.796,72.347    C565.257,281.569,563.532,285.839,560.084,285.839z" fill="#164194" data-original="#000000" style="" class=""></path></g></g><g xmlns="http://www.w3.org/2000/svg"></g><g xmlns="http://www.w3.org/2000/svg"></g><g xmlns="http://www.w3.org/2000/svg"></g><g xmlns="http://www.w3.org/2000/svg"></g><g xmlns="http://www.w3.org/2000/svg"></g><g xmlns="http://www.w3.org/2000/svg"></g><g xmlns="http://www.w3.org/2000/svg"></g><g xmlns="http://www.w3.org/2000/svg"></g><g xmlns="http://www.w3.org/2000/svg"></g><g xmlns="http://www.w3.org/2000/svg"></g><g xmlns="http://www.w3.org/2000/svg"></g><g xmlns="http://www.w3.org/2000/svg"></g><g xmlns="http://www.w3.org/2000/svg"></g><g xmlns="http://www.w3.org/2000/svg"></g><g xmlns="http://www.w3.org/2000/svg"></g></g></svg>
          <h4 style="color: #164194">رهگیری مرسوله‌های پستی شرکت ملی پست</h4>
        </div>
        <div class="d-flex justify-content-center">
          <div class="input-group input-search mb-4">
            <input v-model="code" @keypress.enter="checkTrackingCode(code)" type="text" class="form-control" maxlength="24" placeholder="کد رهگیری پستی یا شناسه کالا را وارد کنید">
            <div class="input-group-append">
              <b-overlay class="d-inline-block">
                <button @click="checkTrackingCode(code)" class="btn btn-warning" type="button"><i class="ti-search"></i></button>
              </b-overlay>
            </div>
          </div>
        </div>
        <div id="response"></div>
      </b-overlay>
      <div class="col-lg-3 order-lg-first mt-5 widgets">
        <div class="card">
          <div class="card-body d-flex justify-content-between align-items-center">
            <div class="ti-archive"></div>
            <h5>تحویل به اداره پست</h5>
            <h5 class="btn btn-light">{{ info.all }}</h5>
          </div>
        </div>
        <div class="card">
          <div class="card-body d-flex justify-content-between align-items-center">
            <div class="ti-truck"></div>
            <h5>رهسپار به نقطه پستی</h5>
            <h5 class="btn btn-warning">{{ info.ongoing }}</h5>
          </div>
        </div>
        <div class="card">
          <div class="card-body d-flex justify-content-between align-items-center">
            <div class="ti-map-alt"></div>
            <h5>تحویل به نامه رسان</h5>
            <h5 class="btn btn-success">{{ info.postman }}</h5>
          </div>
        </div>
      </div>
    </div>

  </main>
</template>

<script>
import axios from "axios";
export default {
  data(){return {
    code: "",
    loading: {search: false},
    info: {all:0, ongoing:0, postman:0}
  }},
  methods: {
    checkTrackingCode(code){
      this.loading.search = true;
      axios.get('/admin/delivery/checkTrackingCode', {params: {code}}).then(({data}) => {
        if( data ){
          $("#response").html(data.replace(/header/gi, 'p-header'));
          $("#response").slideDown(150);
        }else{
          toastr['error']("کد رهگیری مرسوله اشتباه است.");
        }
        this.loading.search = false;
      })
    },
    getInfo(){
      axios.get('/admin/delivery/deliveryInfo').then(({data}) => {
        this.info = data;
      });
    }
  },
  mounted() {
    this.getInfo();
    if( this.$route.params.code ){
      this.code = this.$route.params.code;
      this.checkTrackingCode(this.code);
    }
  }
}
</script>

<style>
  .newtdp-header {
    font-weight: bold;
    text-align: right;
    background-color: #00226c;
    color: #ffd008;
    padding: 5px;
    border-left: 1px solid white;
    font-size: 11pt;
  }
  #response div.row {
    margin-left: 0;
    margin-right: 0;
  }
  #response{
    width: 98%; margin: 0 auto
  }
  #response .alert.alert-warning {
    width: 100%;
  }
  #response .moreinfo{display: none}
  #response .postmanimg {
    border-radius: 52px;
    width: 70px;
    height: 70px;
  }

  .widgets{width: 99.6%; margin: 0 auto}
  .widgets [class^=ti-]{font-size: 40px;}
  .input-search{width: 98%;}
  .tracking-code-information_number {
    color: #8a6d3b;
    background-color: #fcf8e3;
    border: 1px solid #faebcc;
    padding: 15px;
    text-align: center;
    border-radius: 7px;
    width: 98%;
    margin: 0 auto;
    margin-bottom: 30px;
  }

  .tracking-code-information_more .row .p-header, .tracking-code-information_more .form-horizontal>.form-group .p-header {
    background-color: #164194;
    border-radius: 4px;
    border-left: 1px solid white;
    color: #ffda24;
    display: flex;
    align-items: center;
    padding: 5px 10px;
    margin-bottom: 5px;
    margin-top: 15px;
  }
  .tracking-code-information_more{
    width: 96%;
    margin: 0 auto;
  }
  .tracking-code-information_more .row .p-header svg, .tracking-code-information_more .form-horizontal>.form-group .p-header svg {
    margin-left: 7px;
  }
</style>
