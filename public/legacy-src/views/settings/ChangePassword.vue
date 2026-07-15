<template>
  <main class="main-content">
    <div class="card">
      <div class="card-header"><h5>تغییر رمز عبور</h5></div>
      <div class="card-body">
        <p class="card-text mb-0">جهت تامین امنیت حساب کاربری خود، بهتر است هر از چند گاهی رمز خود را تغییر دهید.</p>
        <p class="card-text">همچنین بهتر است در رمز خود از حروف کوچک، بزرگ، اعداد و کاراکتر های ویژه استفاده نمایدد.</p>
        <div class="row">
          <div class="col-lg-6">
            <div class="form-group">
              <label class="col-form-label">رمز عبور:</label>
              <input type="password" class="form-control" v-model="password" @keydown.enter="changePass">
            </div>
            <div class="form-group">
              <label class="col-form-label">تکرار رمز عبور:</label>
              <input type="password" class="form-control" v-model="password2" @keydown.enter="changePass">
            </div>
            <div class="progress m-b-20" style="height: 3px;">
              <div :class="['progress-bar', barColor]" role="progressbar" :style="`width: ${progressbar}%;`" aria-valuemin="0" aria-valuemax="100"></div>
            </div>
          </div>
        </div>
      </div>
      <div class="card-footer text-muted">
        <button @click="changePass" class="btn btn-primary">ذخیره سازی رمز</button>
      </div>
    </div>
  </main>
</template>

<script>
import axios from "axios";
export default {
  data(){
    return{
      barColor: "",
      progressbar: 0,
      password: "",
      password2: ""
    }
  },
  methods:{
    changePass(){
      if( this.progressbar >= 60 ){
        if( this.password == this.password2 ){
          axios.post('/admin/settings/userdata', {
            password: this.password,
            password2: this.password2
          }).then(({data}) => {
            if( data && data.ok ){
              this.password = "";
              this.password2 = "";
              toastr['success'](data.msg);
            }else{
              toastr['error'](data.error);
            }
          });
        }else{
          toastr['error']("رمز عبور های وارد شده با هم یکسان نیستند.");
        }
      }else{
        toastr['error']("لطفا رمز عبور امن تری برای خود انتخاب کنید.");
      }
    }
  },
  watch:{
    progressbar: {
      handler(value){
        if( value >= 60 ){
          this.barColor = "bg-success";
        }else if( value >= 50 ){
          this.barColor = "bg-warning";
        }else{
          this.barColor = "bg-danger";
        }
      }
    },
    password: {
      handler(pass){
        this.progressbar = 0;
        if( pass.toString().length >= 6 ) this.progressbar += 5;
        if( pass.toString().length >= 8 ) this.progressbar += 5;
        if( pass.toString().length >= 10 ) this.progressbar += 10;
        if( /[0-9]/g.test( pass.toString() ) ) this.progressbar += 10;
        if( /[A-Z]/g.test( pass.toString() ) ) this.progressbar += 10;
        if( /[a-z]/g.test( pass.toString() ) ) this.progressbar += 20;
        if( /[`!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~]/g.test( pass.toString() ) ) this.progressbar += 40;
        if( pass.toString().length < 8 ){
          this.progressbar /= 2;
        }

      }
    }
  }
}
</script>

<style scoped>

</style>
