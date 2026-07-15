<template>
  <main class="main-content">
    <div class="card">
      <div class="card-header"><h5>دریافت جواز</h5></div>
      <div class="card-body">
        <div v-if="step == 'login'" class="form-group">
          <div class="col-sm-12">
            <label>شماره موبایل</label>
            <input type="tel" id="mobile" @keydown.enter="login" class="form-control" maxlength="11">
          </div>
        </div>

        <div v-else-if="step == 'verify'" class="form-group">
          <div class="col-sm-12">
            <label>توکن</label>
            <input type="tel" id="token" @keydown.enter="verify" class="form-control" maxlength="6">
          </div>
        </div>
      </div>
      <div class="card-footer text-muted">
        <button v-if="step == 'login'" @click="login" class="btn btn-primary">درخواست توکن</button>
        <button v-else-if="step == 'verify'" @click="verify" class="btn btn-primary">بررسی توکن</button>
      </div>
    </div>
  </main>
</template>

<script>
import util from '../../assets/pureFunctions'
import axios from "axios";

export default {
  data(){
    return {
      step: "login",
      mobile: "",
      expireTime: 0
    }
  },
  methods: {
    login(){
      let mobile = document.querySelector("#mobile").value;

      axios.post('/admin/wallet/authenticate', {mobile, step: "login"}).then(({data}) => {
        if( data.ok ){
          this.step = 'verify';
          $("#token").val('').focus();
        }else{
          toastr['error'](data.error);
        }
      });
    },

    verify(){
      let token = document.querySelector("#token").value;

      axios.post('/admin/wallet/authenticate', {token, step: "verify"}).then(({data}) => {
        if( data.ok ){
          this.step = 'login';
          util.setAuthenticateTime(data.expireTime);
          this.$router.back();
        }else{
          toastr['error'](data.error);
        }
      });
    }
  },
  mounted() {
    setTimeout(function (){
      $("#mobile").focus();
    }, 100);
  }
}
</script>

<style scoped>

</style>
